import { describe, expect, it, vi } from "vitest";
import { prepareCapture } from "../../apps/worker/src/prepare-capture";
describe("capture preparation before browser PCM", () => {
  it("waits for identity and current app authorization before signaling ready", async () => {
    const order: string[] = [];
    let finishIdentity!: () => void;
    const identity = new Promise<void>((resolve) => {
      finishIdentity = resolve;
    });
    const stop = vi.fn();
    const pending = prepareCapture({
      stream: {
        prepare: async () => {
          order.push("identity");
          await identity;
        },
        stop,
      },
      current: () => true,
      authorize: async () => {
        order.push("lease");
      },
      ready: () => {
        order.push("ready");
      },
    });
    expect(order).toEqual(["identity"]);
    finishIdentity();
    await pending;
    expect(order).toEqual(["identity", "lease", "ready"]);
    expect(stop).not.toHaveBeenCalled();
  });
  it("discards the stream if a handoff/socket loss wins during identity verification", async () => {
    const stop = vi.fn(),
      authorize = vi.fn(),
      ready = vi.fn();
    await expect(
      prepareCapture({
        stream: { prepare: async () => {}, stop },
        current: () => false,
        authorize,
        ready,
      }),
    ).rejects.toMatchObject({ code: "CAPTURE_ENDED" });
    expect(stop).toHaveBeenCalledOnce();
    expect(authorize).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });
  it("never permits audio after identity or final lease verification failure", async () => {
    for (const failure of ["identity", "lease"]) {
      const stop = vi.fn(),
        ready = vi.fn();
      await expect(
        prepareCapture({
          stream: {
            prepare: async () => {
              if (failure === "identity") throw Error("identity denied");
            },
            stop,
          },
          current: () => true,
          authorize: async () => {
            throw Error("lease denied");
          },
          ready,
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(stop).toHaveBeenCalledOnce();
      expect(ready).not.toHaveBeenCalled();
    }
  });
});
