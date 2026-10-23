type Listener = (...args: unknown[]) => void;
interface Events {
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
}
export interface HiddenInputTerminal {
  input: Events & {
    isTTY?: boolean;
    isRaw?: boolean;
    readableFlowing?: boolean | null;
    setRawMode(enabled: boolean): unknown;
    listenerCount(event: string): number;
    pause(): unknown;
    resume(): unknown;
  };
  output: Events & {
    isTTY?: boolean;
    write(text: string): unknown;
  };
  lifecycle?: Events;
}
export type HiddenInputErrorCode =
  | "TTY_REQUIRED"
  | "INVALID_OPTIONS"
  | "INPUT_BUSY"
  | "CANCELLED"
  | "END_OF_INPUT"
  | "EMPTY_INPUT"
  | "MULTILINE_INPUT"
  | "INPUT_TOO_LONG"
  | "INVALID_INPUT"
  | "TERMINAL_ERROR";
const messages: Record<HiddenInputErrorCode, string> = {
  TTY_REQUIRED: "Hidden input requires an interactive input and output TTY.",
  INVALID_OPTIONS: "Hidden input options are invalid.",
  INPUT_BUSY: "The terminal input is already in use.",
  CANCELLED: "Hidden input was cancelled.",
  END_OF_INPUT: "The terminal ended before input was confirmed.",
  EMPTY_INPUT: "Hidden input cannot be empty.",
  MULTILINE_INPUT: "Paste a single line, then press Enter separately.",
  INPUT_TOO_LONG: "Hidden input exceeds the permitted length.",
  INVALID_INPUT: "Hidden input contains an unsupported character or sequence.",
  TERMINAL_ERROR: "The terminal could not complete hidden input safely.",
};
export class HiddenTerminalInputError extends Error {
  constructor(readonly code: HiddenInputErrorCode) {
    super(messages[code]);
    this.name = "HiddenTerminalInputError";
  }
}
export interface HiddenTerminalInputOptions {
  terminal?: HiddenInputTerminal;
  /** ASCII token characters, default 8192, hard maximum 16384. */
  maxLength?: number;
  signal?: AbortSignal;
}
const active = new WeakSet<HiddenInputTerminal["input"]>();
const pasteOn = "\x1b[?2004h",
  pasteOff = "\x1b[?2004l";
const pasteStart = "\x1b[200~",
  pasteEnd = "\x1b[201~";

/** No readline/history, echo, input logging, file writes or process arguments. */
export async function hiddenTerminalInput(
  prompt: string,
  options: HiddenTerminalInputOptions = {},
): Promise<string> {
  const terminal = options.terminal ?? {
    input: process.stdin,
    output: process.stdout,
    lifecycle: process,
  };
  const { input, output } = terminal;
  const lifecycle = terminal.lifecycle ?? process;
  const maxLength = options.maxLength ?? 8192;
  if (
    typeof prompt !== "string" ||
    prompt.length > 1024 ||
    /[\x00-\x08\x0b-\x1f\x7f]/.test(prompt) ||
    !Number.isSafeInteger(maxLength) ||
    maxLength < 1 ||
    maxLength > 16384
  )
    throw new HiddenTerminalInputError("INVALID_OPTIONS");
  if (
    input.isTTY !== true ||
    output.isTTY !== true ||
    typeof input.setRawMode !== "function"
  )
    throw new HiddenTerminalInputError("TTY_REQUIRED");
  if (
    active.has(input) ||
    input.listenerCount("data") ||
    input.listenerCount("readable")
  )
    throw new HiddenTerminalInputError("INPUT_BUSY");
  if (options.signal?.aborted) throw new HiddenTerminalInputError("CANCELLED");
  active.add(input);
  const wasRaw = input.isRaw === true,
    wasFlowing = input.readableFlowing === true;
  return new Promise<string>((resolve, reject) => {
    let value = "",
      escape = "",
      pasting = false,
      pasteFailure: HiddenInputErrorCode | undefined;
    let finished = false,
      rawAttempted = false,
      pasteEnabled = false,
      cleaned = false;
    let enter: "\r" | "\n" | "\r\n" | undefined;
    let submitTimer: ReturnType<typeof setTimeout> | undefined;
    let pasteTimer: ReturnType<typeof setTimeout> | undefined;
    let escapeTimer: ReturnType<typeof setTimeout> | undefined;
    const subscriptions: [Events, string, Listener][] = [];
    function listen(source: Events, event: string, listener: Listener) {
      // Record first so even a partially failed registration is removed during cleanup.
      subscriptions.push([source, event, listener]);
      source.on(event, listener);
    }
    function cleanup() {
      if (cleaned) return true;
      cleaned = true;
      clearTimeout(submitTimer);
      clearTimeout(pasteTimer);
      clearTimeout(escapeTimer);
      let ok = true;
      const attempt = (run: () => unknown) => {
        try {
          run();
        } catch {
          ok = false;
        }
      };
      attempt(() => input.pause());
      for (const [source, event, listener] of subscriptions)
        attempt(() => source.removeListener(event, listener));
      options.signal?.removeEventListener("abort", onCancel);
      if (pasteEnabled) attempt(() => output.write(pasteOff));
      if (rawAttempted) attempt(() => input.setRawMode(wasRaw));
      if (wasFlowing) attempt(() => input.resume());
      if (pasteEnabled) attempt(() => output.write("\n"));
      active.delete(input);
      value = "";
      escape = "";
      return ok;
    }
    function finish(code?: HiddenInputErrorCode) {
      if (finished) return;
      finished = true;
      const result = value;
      if (!cleanup()) code = "TERMINAL_ERROR";
      if (code) reject(new HiddenTerminalInputError(code));
      else resolve(result);
    }
    function onCancel() {
      if (pasting) {
        // Keep echo disabled until the paste tail is consumed; cancellation must not
        // release a later chunk back to the shell. The original paste deadline remains.
        pasteFailure = "CANCELLED";
        value = "";
        return;
      }
      finish("CANCELLED");
    }
    function onPasteTimeout() {
      finish(pasteFailure ?? "TERMINAL_ERROR");
    }
    function onEnd() {
      finish("END_OF_INPUT");
    }
    function onError() {
      finish("TERMINAL_ERROR");
    }
    function onExit() {
      finished = true;
      cleanup();
    }
    function invalid(code: HiddenInputErrorCode) {
      if (pasting)
        pasteFailure ??= code; // Drain the paste before returning control to the shell.
      else finish(code);
    }
    function character(char: string) {
      if (char === "\x03") {
        onCancel();
        return;
      }
      if (escape || char === "\x1b") {
        clearTimeout(escapeTimer);
        escape += char;
        if (escape === pasteStart) {
          if (pasting || enter) {
            escape = "";
            invalid("INVALID_INPUT");
            return;
          }
          escape = "";
          pasting = true;
          pasteTimer = setTimeout(onPasteTimeout, 10_000);
        } else if (escape === pasteEnd) {
          if (!pasting) {
            escape = "";
            finish("INVALID_INPUT");
            return;
          }
          escape = "";
          pasting = false;
          clearTimeout(pasteTimer);
          if (pasteFailure) finish(pasteFailure);
        } else if (
          !pasteStart.startsWith(escape) &&
          !pasteEnd.startsWith(escape)
        ) {
          escape = "";
          invalid("INVALID_INPUT");
        } else if (!pasting) escapeTimer = setTimeout(onError, 500);
        return;
      }
      if (pasting && (char === "\r" || char === "\n")) {
        invalid("MULTILINE_INPUT");
        return;
      }
      if (pasting && pasteFailure) return;
      if (char === "\x04") {
        invalid("END_OF_INPUT");
        return;
      }
      if (enter) {
        if (enter === "\r" && char === "\n") {
          enter = "\r\n";
          return;
        }
        finish("MULTILINE_INPUT");
        return;
      }
      if (char === "\r" || char === "\n") {
        enter = char;
        return;
      }
      if (char === "\x7f" || char === "\b") {
        if (pasting) invalid("INVALID_INPUT");
        else value = value.slice(0, -1);
        return;
      }
      // Provider tokens are opaque printable ASCII; never normalize or trim them silently.
      const code = char.charCodeAt(0);
      if (code < 0x21 || code > 0x7e) {
        invalid("INVALID_INPUT");
        return;
      }
      if (value.length >= maxLength) {
        invalid("INPUT_TOO_LONG");
        return;
      }
      value += char;
    }
    const onData: Listener = (chunk) => {
      if (finished) return;
      if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
        onError();
        return;
      }
      clearTimeout(submitTimer);
      for (let i = 0; i < chunk.length && !finished; i++)
        character(
          typeof chunk === "string" ? chunk[i] : String.fromCharCode(chunk[i]),
        );
      // Also reject trailing input delivered in the next chunk, rather than accepting a pasted first line.
      if (!finished && enter && !pasting && !escape)
        submitTimer = setTimeout(
          () => finish(value ? undefined : "EMPTY_INPUT"),
          25,
        );
    };
    try {
      input.pause();
      listen(lifecycle, "exit", onExit);
      for (const event of ["SIGINT", "SIGTERM", "SIGHUP"])
        listen(lifecycle, event, onCancel);
      listen(input, "end", onEnd);
      listen(input, "close", onEnd);
      listen(input, "error", onError);
      listen(output, "error", onError);
      options.signal?.addEventListener("abort", onCancel, { once: true });
      rawAttempted = true;
      input.setRawMode(true);
      listen(input, "data", onData);
      pasteEnabled = true;
      output.write(pasteOn);
      if (!finished) output.write(prompt);
      if (!finished) input.resume();
    } catch {
      finish("TERMINAL_ERROR");
    }
  });
}
