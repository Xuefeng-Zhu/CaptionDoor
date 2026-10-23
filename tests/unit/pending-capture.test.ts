import { describe, expect, it, vi } from "vitest";
import { withPendingCapture } from "../../apps/worker/src/pending-capture";
describe("single worker pending capture starts", () => {
  it("two socket starts cannot both reserve budget/start transport while the first awaits", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reserve = vi.fn(async () => held),
      paid = vi.fn();
    const first = withPendingCapture("household:visit", async () => {
      await reserve();
      paid();
    });
    await expect(
      withPendingCapture("household:visit", async () => {
        await reserve();
        paid();
      }),
    ).rejects.toMatchObject({ code: "CAPTURE_ACTIVE", status: 409 });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(paid).not.toHaveBeenCalled();
    release();
    await first;
    expect(paid).toHaveBeenCalledTimes(1);
  });
  it("failure releases only its own tenant/visit slot", async () => {
    await expect(
      withPendingCapture("one:visit", async () => {
        throw new Error("fictional failure");
      }),
    ).rejects.toThrow("fictional failure");
    await expect(
      withPendingCapture("one:visit", async () => "retry"),
    ).resolves.toBe("retry");
    await expect(
      withPendingCapture("one:visit", async () =>
        withPendingCapture("two:visit", async () => "separate tenant"),
      ),
    ).resolves.toBe("separate tenant");
  });
});
