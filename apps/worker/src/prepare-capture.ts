import { AppError } from "@captiondoor/domain";
/** No PCM-ready signal until AWS identity and the current app lease have both been rechecked. */
export async function prepareCapture(input: {
  stream: { prepare: () => Promise<void>; stop: () => void };
  current: () => boolean;
  authorize: () => Promise<unknown>;
  ready: () => void;
}) {
  try {
    await input.stream.prepare();
    if (!input.current())
      throw new AppError(
        "CAPTURE_ENDED",
        409,
        "Caption connection ended while authorization was checked.",
      );
    await input.authorize();
    if (!input.current())
      throw new AppError(
        "CAPTURE_ENDED",
        409,
        "Caption connection ended while authorization was checked.",
      );
    input.ready();
  } catch (error) {
    input.stream.stop();
    throw error;
  }
}
