// A speech endpoint's 2xx turned into a clip, or a readable failure. A WAV is rewritten under a
// plain header (`wav.ts`); MP3 and Opus are kept byte for byte once `probeClip` reads them. An
// answer in another format than asked is refused: a server ignoring `response_format` would
// otherwise leave an MP3 endpoint writing WAV.
import type { AudioFormat, SampleRate } from "@/types";
import { AUDIO_MIME, encodingProblems, FORMAT_LABEL } from "@/lib/endpointShapes";
import { probeClip } from "~/audio/probe";
import { ProviderError } from "~/providers/http";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { plainWav } from "~/providers/wav";

/** A slow body ends in the attempt clock's `TimeoutError`; `call` returns before the body is in. */
const timedOut = (e: unknown): boolean =>
  e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

const cutOff = (target: ProviderTarget, res: Response, what: string): ProviderError =>
  new ProviderError(
    `${target.name} answered ${res.status} but did not finish sending ${what} within ${target.timeoutSec} s`,
    res.status,
    true,
  );

/** For a provider that answers JSON around the audio. */
export async function jsonAnswer<T>(
  target: ProviderTarget,
  res: Response,
  signal: AbortSignal,
): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    if (timedOut(e)) throw cutOff(target, res, "its answer");
    throw new ProviderError(
      `${target.name} answered ${res.status} with something that is not JSON`,
      res.status,
      false,
    );
  }
}

export interface AnsweredAudio {
  bytes: Uint8Array;
  format: AudioFormat;
  mime: string;
  duration: number;
}

/** A 200 carrying JSON or text is a refusal dressed as success. None of these is retried. */
export async function audioAnswer(
  target: ProviderTarget,
  res: Response,
  signal: AbortSignal,
  format: AudioFormat,
): Promise<AnsweredAudio> {
  const type = res.headers.get("content-type") ?? "";
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    if (timedOut(e)) throw cutOff(target, res, "the audio");
    throw new ProviderError(
      `${target.name} stopped sending audio part-way: ${(e as Error).message}`,
      0,
      true,
    );
  }
  if (/json|text\//i.test(type)) {
    const said = new TextDecoder().decode(bytes.subarray(0, 300)).replace(/\s+/g, " ").trim();
    throw new ProviderError(
      `${target.name} answered ${res.status} but sent no audio${said ? `: ${said}` : ""}`,
      res.status,
      false,
    );
  }
  return audioClip(target, bytes, format, res.status);
}

/** Bytes held to the format asked for; `status` is only for the message. Not retried. */
export async function audioClip(
  target: ProviderTarget,
  bytes: Uint8Array,
  format: AudioFormat,
  status: number,
): Promise<AnsweredAudio> {
  if (!bytes.byteLength)
    throw new ProviderError(`${target.name} answered ${status} with nothing in it`, status, false);
  try {
    if (format === "wav") {
      const wav = plainWav(bytes);
      return { bytes: wav.bytes, format, mime: AUDIO_MIME.wav, duration: wav.duration };
    }
    const { duration } = await probeClip(bytes, format);
    return { bytes, format, mime: AUDIO_MIME[format], duration };
  } catch (e) {
    throw new ProviderError(
      `${target.name} answered with something that is not ${format === "wav" ? "a WAV" : `an ${FORMAT_LABEL[format]} file`} this server can read: ${(e as Error).message}`,
      status,
      false,
    );
  }
}

/** Fails before any request with the first reason the Endpoints page shows (`encodingProblems`). */
export function refuseEncoding(
  target: ProviderTarget,
  { encoding, sampleRate }: Pick<SpeechInput, "encoding" | "sampleRate">,
): void {
  const [problem] = encodingProblems({
    baseUrl: target.baseUrl,
    encoding,
    sampleRate: sampleRate as SampleRate | null,
  });
  if (problem)
    throw new ProviderError(
      `${target.name} cannot be asked for this line's audio as it is set up: ${problem}. Change it on the Endpoints page.`,
      0,
      false,
    );
}
