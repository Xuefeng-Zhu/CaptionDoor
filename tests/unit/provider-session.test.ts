import { describe, expect, it } from "vitest";
import {
  parseProviderSessionArgs,
  selectSessionDevice,
  terminateOwned,
  main,
  runOwnedSessionCommand,
} from "../../scripts/provider-session";
import { vi } from "vitest";
describe("user provider launcher safe entry", () => {
  it("requires both exact execution markers and defaults to help", () => {
    expect(parseProviderSessionArgs([])).toEqual({ start: false });
    expect(parseProviderSessionArgs(["--help"])).toEqual({ start: false });
    expect(parseProviderSessionArgs(["--start", "--approved-cleanup"])).toEqual(
      { start: true },
    );
    expect(parseProviderSessionArgs(["--approved-cleanup", "--start"])).toEqual(
      { start: true },
    );
  });
  it.each([
    ["--start"],
    ["--approved-cleanup"],
    ["--start", "--start"],
    ["--start", "--approved-cleanup", "--token=fictional-secret"],
    ["--help", "--start"],
  ])("rejects noncanonical or secret-bearing args safely: %s", (...args) => {
    expect(() => parseProviderSessionArgs(args)).toThrow(
      "INVALID_SESSION_ARGUMENTS",
    );
  });
  it("help works without a terminal and does not include private environment values", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const before = process.env.RING_PLAYGROUND_TOKEN;
    process.env.RING_PLAYGROUND_TOKEN = "fictional-secret-not-for-output";
    try {
      await expect(main(["--help"])).resolves.toBe(0);
      expect(log.mock.calls.flat().join(" ")).not.toContain(
        "fictional-secret-not-for-output",
      );
    } finally {
      if (before === undefined) delete process.env.RING_PLAYGROUND_TOKEN;
      else process.env.RING_PLAYGROUND_TOKEN = before;
      log.mockRestore();
    }
  });
  it("selects only a numbered device from actual discovery", () => {
    expect(
      selectSessionDevice(
        [{ id: "fixture-device-a" }, { id: "fixture-device-b" }],
        "2",
      ),
    ).toBe("fixture-device-b");
  });
  it.each(["", "0", "01", "3", "1.0", "-1", "1\n", "fictional-secret", "1000"])(
    "refuses an invalid choice without repeating it: %s",
    (value) => {
      let message = "";
      try {
        selectSessionDevice([{ id: "fixture-device" }], value);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("DEVICE_SELECTION_REQUIRED");
      expect(message).not.toContain("fictional-secret");
    },
  );
  it("rejects malicious provider identifiers without printing them", () => {
    expect(() => selectSessionDevice([{ id: "private\nvalue" }], "1")).toThrow(
      "DEVICE_SELECTION_REQUIRED",
    );
  });
});

describe("only the owned detached process group must finish", () => {
  it("waits for a real owned descendant after cancellation even when its parent exits first", async () => {
    const abort = new AbortController();
    // Fictional Node processes only: no service, provider, token, key or database.
    const descendant = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const parent = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});process.stdout.write(String(c.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`;
    const timer = setTimeout(() => abort.abort(), 500);
    try {
      const result = await runOwnedSessionCommand(
        process.execPath,
        ["-e", parent],
        { NODE_ENV: "test" },
        8000,
        abort.signal,
      );
      expect(result.code).toBe(2);
      const pid = Number(result.stdout);
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      clearTimeout(timer);
    }
  }, 12000);
  function fixture(mode: "term" | "kill" | "stuck" | "absent") {
    let alive = mode !== "absent",
      time = 0;
    const signals: (NodeJS.Signals | 0)[] = [];
    return {
      signals,
      io: {
        kill(pid: number, signal: NodeJS.Signals | 0) {
          expect(pid).toBe(-12345);
          signals.push(signal);
          if (!alive)
            throw Object.assign(new Error("fixture"), { code: "ESRCH" });
          if (signal === "SIGTERM" && mode === "term") alive = false;
          if (signal === "SIGKILL" && mode === "kill") alive = false;
          return true;
        },
        now: () => time,
        wait: async (ms: number) => {
          time += ms;
        },
      },
    };
  }
  it("returns when the exact owned group is already absent", async () => {
    const f = fixture("absent");
    await terminateOwned({ pid: 12345 }, f.io);
    expect(f.signals).toEqual([0]);
  });
  it("stops descendants even when the original parent has exited", async () => {
    const f = fixture("term");
    await terminateOwned({ pid: 12345 }, f.io);
    expect(f.signals).toContain("SIGTERM");
    expect(f.signals).not.toContain("SIGKILL");
  });
  it("escalates only the owned stubborn group and waits for absence", async () => {
    const f = fixture("kill");
    await terminateOwned({ pid: 12345 }, f.io);
    expect(f.signals).toContain("SIGKILL");
    expect(f.signals.at(-1)).toBe(0);
  });
  it("blocks rather than claiming shutdown if the owned group remains", async () => {
    const f = fixture("stuck");
    await expect(terminateOwned({ pid: 12345 }, f.io)).rejects.toThrow(
      "OWNED_PROCESS_STOP_PENDING",
    );
  });
});
