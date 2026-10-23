import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hiddenTerminalInput,
  type HiddenInputTerminal,
  type HiddenInputErrorCode,
} from "../../scripts/hidden-terminal-input";

class Input extends EventEmitter {
  isTTY = true;
  isRaw = false;
  readableFlowing = false;
  setRawMode = vi.fn((raw: boolean) => {
    this.isRaw = raw;
  });
  pause = vi.fn(() => {
    this.readableFlowing = false;
  });
  resume = vi.fn(() => {
    this.readableFlowing = true;
  });
}
function terminal() {
  const input = new Input(),
    output = Object.assign(new EventEmitter(), {
      isTTY: true,
      write: vi.fn((_text: string) => true),
    }),
    lifecycle = new EventEmitter();
  const value: HiddenInputTerminal = { input, output, lifecycle };
  return { input, output, lifecycle, value };
}
type Fixture = ReturnType<typeof terminal>;
function expectClean(f: Fixture, wasRaw = false, wasFlowing = false) {
  expect(f.input.isRaw).toBe(wasRaw);
  expect(f.input.readableFlowing).toBe(wasFlowing);
  expect(f.input.eventNames()).toEqual([]);
  expect(f.output.eventNames()).toEqual([]);
  expect(f.lifecycle.eventNames()).toEqual([]);
}
async function failure(
  f: Fixture,
  send: () => void,
  code: HiddenInputErrorCode,
  maxLength?: number,
) {
  const pending = hiddenTerminalInput("Token (hidden): ", {
    terminal: f.value,
    maxLength,
  });
  const check = expect(pending).rejects.toMatchObject({
    name: "HiddenTerminalInputError",
    code,
  });
  send();
  await vi.runAllTimersAsync();
  await check;
  expectClean(f);
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("hidden terminal token input with fictional data only", () => {
  it("reads a token only after Enter, with no echo and no retained listeners", async () => {
    const f = terminal(),
      secret = "fictional-opaque-token";
    const pending = hiddenTerminalInput("Token (hidden): ", {
      terminal: f.value,
    });
    expect(f.input.isRaw).toBe(true);
    f.input.emit("data", Buffer.from(secret));
    let complete = false;
    void pending.then(() => {
      complete = true;
    });
    await Promise.resolve();
    expect(complete).toBe(false);
    f.input.emit("data", Buffer.from("\r"));
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe(secret);
    expect(
      f.output.write.mock.calls.map(([text]) => text).join(""),
    ).not.toContain(secret);
    expect(f.input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expectClean(f);
  });
  it("handles both backspace bytes without printing the supplied text", async () => {
    const f = terminal(),
      pending = hiddenTerminalInput("Token: ", { terminal: f.value });
    f.input.emit("data", "abX\x7fc\bZ\r\n");
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("abZ");
    expectClean(f);
  });
  it("restores an already raw, flowing terminal rather than forcing cooked mode", async () => {
    const f = terminal();
    f.input.isRaw = true;
    f.input.readableFlowing = true;
    const pending = hiddenTerminalInput("Token: ", { terminal: f.value });
    f.input.emit("data", "fictional\n");
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("fictional");
    expect(f.input.setRawMode.mock.calls).toEqual([[true], [true]]);
    expectClean(f, true, true);
  });
  it.each(["input", "output"] as const)(
    "refuses a non-TTY %s before changing modes or writing",
    async (which) => {
      const f = terminal();
      f[which].isTTY = false;
      await expect(
        hiddenTerminalInput("Token: ", { terminal: f.value }),
      ).rejects.toMatchObject({ code: "TTY_REQUIRED" });
      expect(f.input.setRawMode).not.toHaveBeenCalled();
      expect(f.output.write).not.toHaveBeenCalled();
    },
  );
  it.each([0, -1, 16385, 1.5, NaN])(
    "refuses invalid maxLength %s",
    async (maxLength) => {
      const f = terminal();
      await expect(
        hiddenTerminalInput("Token: ", { terminal: f.value, maxLength }),
      ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
      expect(f.output.write).not.toHaveBeenCalled();
    },
  );
  it("rejects concurrent consumers and does not interfere with an existing reader", async () => {
    const f = terminal(),
      pending = hiddenTerminalInput("Token: ", { terminal: f.value });
    await expect(
      hiddenTerminalInput("Other: ", { terminal: f.value }),
    ).rejects.toMatchObject({ code: "INPUT_BUSY" });
    f.input.emit("data", "one\r");
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("one");
    const reader = vi.fn();
    f.input.on("data", reader);
    await expect(
      hiddenTerminalInput("Other: ", { terminal: f.value }),
    ).rejects.toMatchObject({ code: "INPUT_BUSY" });
    expect(f.input.listeners("data")).toEqual([reader]);
  });
  it.each(["\x03", "\x04", "\r", "abcdef", "contains space", "\x1b[A"])(
    "rejects a cancellation, EOF, empty, excessive or unsupported input",
    async (data) => {
      const f = terminal();
      const code =
        data === "\x03"
          ? "CANCELLED"
          : data === "\x04"
            ? "END_OF_INPUT"
            : data === "\r"
              ? "EMPTY_INPUT"
              : data === "abcdef"
                ? "INPUT_TOO_LONG"
                : "INVALID_INPUT";
      await failure(
        f,
        () => f.input.emit("data", data),
        code,
        data === "abcdef" ? 5 : undefined,
      );
    },
  );
  it.each(["one\ntwo\n", "one\rtwo\r", "one\r\nsecond\r\n"])(
    "never accepts the first line of a multiline data chunk",
    async (data) => {
      const f = terminal();
      await failure(f, () => f.input.emit("data", data), "MULTILINE_INPUT");
    },
  );
  it("rejects multiline payload split immediately after a bare Enter", async () => {
    const f = terminal();
    await failure(
      f,
      () => {
        f.input.emit("data", "one\r");
        f.input.emit("data", "two\r");
      },
      "MULTILINE_INPUT",
    );
  });
  it("handles bracketed-paste delimiters split across chunks and requires a separate Enter", async () => {
    const f = terminal(),
      pending = hiddenTerminalInput("Token: ", { terminal: f.value });
    for (const data of ["\x1b[20", "0~fictional-", "token\x1b[2", "01~"])
      f.input.emit("data", data);
    await vi.runAllTimersAsync();
    expect(f.input.isRaw).toBe(true);
    f.input.emit("data", "\r");
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("fictional-token");
    expectClean(f);
  });
  it("drains a rejected multiline paste through its end marker before restoring the terminal", async () => {
    const f = terminal(),
      pending = hiddenTerminalInput("Token: ", { terminal: f.value });
    const check = expect(pending).rejects.toMatchObject({
      code: "MULTILINE_INPUT",
    });
    f.input.emit("data", "\x1b[200~fictional-first\n");
    await vi.advanceTimersByTimeAsync(50);
    expect(f.input.isRaw).toBe(true);
    f.input.emit("data", "fictional-second\x1b[201~");
    await check;
    expect(
      f.output.write.mock.calls.map(([text]) => text).join(""),
    ).not.toMatch(/fictional-first|fictional-second/);
    expectClean(f);
  });
  it.each(["control-c", "abort-signal", "SIGINT"] as const)(
    "drains a split paste after %s before restoring echo",
    async (cancel) => {
      const f = terminal(),
        controller = new AbortController();
      const pending = hiddenTerminalInput("Token: ", {
        terminal: f.value,
        signal: controller.signal,
      });
      const check = expect(pending).rejects.toMatchObject({
        code: "CANCELLED",
      });
      f.input.emit("data", "\x1b[200~fictional-first");
      if (cancel === "control-c") f.input.emit("data", "\x03");
      else if (cancel === "abort-signal")
        controller.abort(new Error("fictional-private-reason"));
      else f.lifecycle.emit("SIGINT");
      await vi.advanceTimersByTimeAsync(50);
      expect(f.input.setRawMode.mock.calls).toEqual([[true]]);
      f.input.emit("data", "fictional-tail\x1b[20");
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.input.isRaw).toBe(true);
      f.input.emit("data", "1~");
      await check;
      expect(f.input.setRawMode.mock.calls).toEqual([[true], [false]]);
      expect(
        f.output.write.mock.calls.map(([text]) => text).join(""),
      ).not.toMatch(/fictional-first|fictional-tail|fictional-private-reason/);
      expectClean(f);
    },
  );
  it.each(["control-c", "abort-signal", "SIGINT"] as const)(
    "bounds a cancelled unfinished paste after %s without resetting its deadline",
    async (cancel) => {
      const f = terminal(),
        controller = new AbortController();
      const pending = hiddenTerminalInput("Token: ", {
        terminal: f.value,
        signal: controller.signal,
      });
      const check = expect(pending).rejects.toMatchObject({
        code: "CANCELLED",
      });
      f.input.emit("data", "\x1b[200~fictional");
      await vi.advanceTimersByTimeAsync(9000);
      if (cancel === "control-c") f.input.emit("data", "\x03");
      else if (cancel === "abort-signal") controller.abort();
      else f.lifecycle.emit("SIGINT");
      f.input.emit("data", "discarded-tail\x1b[20");
      await vi.advanceTimersByTimeAsync(999);
      expect(f.input.setRawMode.mock.calls).toEqual([[true]]);
      await vi.advanceTimersByTimeAsync(1);
      await check;
      expectClean(f);
    },
  );
  it("bounds a malformed unfinished paste and restores the terminal", async () => {
    const f = terminal();
    await failure(
      f,
      () => f.input.emit("data", "\x1b[200~fictional"),
      "TERMINAL_ERROR",
    );
  });
  it.each(["end", "close", "error"])(
    "restores mode on input %s without propagating secret-bearing errors",
    async (event) => {
      const f = terminal();
      await failure(
        f,
        () => {
          f.input.emit("data", "fictional-private");
          f.input.emit(event, new Error("do not expose fictional-private"));
        },
        event === "error" ? "TERMINAL_ERROR" : "END_OF_INPUT",
      );
    },
  );
  it.each(["SIGINT", "SIGTERM", "SIGHUP"])(
    "restores mode on process %s",
    async (event) => {
      const f = terminal();
      await failure(f, () => f.lifecycle.emit(event), "CANCELLED");
    },
  );
  it("restores on process exit without depending on async callbacks", () => {
    const f = terminal();
    void hiddenTerminalInput("Token: ", { terminal: f.value });
    f.lifecycle.emit("exit", 1);
    expectClean(f);
  });
  it("supports AbortSignal before and during prompting", async () => {
    const f = terminal(),
      controller = new AbortController();
    controller.abort();
    await expect(
      hiddenTerminalInput("Token: ", {
        terminal: f.value,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(f.output.write).not.toHaveBeenCalled();
    const other = new AbortController(),
      pending = hiddenTerminalInput("Token: ", {
        terminal: f.value,
        signal: other.signal,
      });
    const check = expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    other.abort(new Error("fictional-sensitive-abort"));
    await check;
    expectClean(f);
  });
  it("restores after partially failed raw-mode setup and sanitizes the error", async () => {
    const f = terminal();
    f.input.setRawMode.mockImplementationOnce((raw) => {
      f.input.isRaw = raw;
      throw new Error("fictional-secret-in-driver");
    });
    await expect(
      hiddenTerminalInput("Token: ", { terminal: f.value }),
    ).rejects.toMatchObject({
      code: "TERMINAL_ERROR",
      message: "The terminal could not complete hidden input safely.",
    });
    expect(f.input.isRaw).toBe(false);
    expectClean(f);
  });
  it("restores mode after prompt write failure or output error", async () => {
    const f = terminal();
    f.output.write.mockImplementationOnce(() => {
      throw new Error("fictional-private-output");
    });
    await expect(
      hiddenTerminalInput("Token: ", { terminal: f.value }),
    ).rejects.toMatchObject({ code: "TERMINAL_ERROR" });
    expectClean(f);
    const g = terminal();
    await failure(
      g,
      () => g.output.emit("error", new Error("fictional-private-output")),
      "TERMINAL_ERROR",
    );
  });
});
