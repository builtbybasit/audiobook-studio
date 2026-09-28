// A successful answer from a speech endpoint, turned into a clip — or into a failure a person can
// read, when it is not the audio that was asked for.
//
// Every speech provider ends the same way: a 2xx whose body is audio in the format the endpoint
// asked for — or, for those that answer JSON around it (Gemini, MiniMax, Qwen), whose JSON leads to
// that audio, read here too (`jsonAnswer`). What "is audio" means depends on the format. A WAV is rewritten under a plain
// header, its duration counted from the samples that arrived (`wav.ts`). An MP3 or an Opus file is
// kept byte for byte — that is the point of asking for one, a tenth of the size — and is read by
// `probeClip` to prove it is what it says and to learn how long it plays. An answer in another
// format than the one asked for is refused rather than kept as what it turned out to be: a local
// server that ignores `response_format` would otherwise leave an endpoint set to MP3 writing WAV.
import type { AudioFormat, SampleRate } from "@/types";
import { AUDIO_MIME, encodingProblems, FORMAT_LABEL } from "@/lib/endpointShapes";
import { probeClip } from "~/audio/probe";
import { ProviderError } from "~/providers/http";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { plainWav } from "~/providers/wav";

/**
 * Whether reading a body failed because the attempt's clock ran out. `call` hands back the answer
 * while its body may still be arriving, under the same per-attempt clock, so a slow body ends in
 * that clock's `TimeoutError` rather than in anything wrong with what was sent.
 */
const timedOut = (e: unknown): boolean =>
  e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

/** The failure for a body the attempt's clock cut off; see `timedOut`. */
const cutOff = (target: ProviderTarget, res: Response, what: string): ProviderError =>
  new ProviderError(
    `${target.name} answered ${res.status} but did not finish sending ${what} within ${target.timeoutSec} s`,
    res.status,
    true,
  );

/**
 * A successful answer's body as JSON, for a provider that answers JSON around the audio. A body
 * that is not JSON is reported as such, and one the clock cut off as a timeout; a cancel throws
 * the signal's reason.
 */
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

/** An answer as a clip: the bytes to keep, what they are, and how long they play. */
export interface AnsweredAudio {
  bytes: Uint8Array;
  format: AudioFormat;
  mime: string;
  duration: number;
}

/**
 * A successful answer's body as a clip in `format`. A 200 that carries JSON or text is a refusal
 * dressed as success — some servers answer that way — and is reported with what it said; an empty
 * body, or one that is not readable audio in `format`, is reported as such. None of them is
 * retried: another attempt at a request that was answered is not what any of them needs. A cancel
 * mid-body throws the signal's reason, as every other cancel does.
 */
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
  if (!bytes.byteLength)
    throw new ProviderError(
      `${target.name} answered ${res.status} with nothing in it`,
      res.status,
      false,
    );
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
      res.status,
      false,
    );
  }
}

/**
 * A line whose format, bitrate and rate this endpoint's API cannot be asked for together fails
 * before any request, with the first reason the Endpoints page shows beside those fields. Sending
 * it anyway would be refused, or answered in something other than what the endpoint says it keeps.
 */
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
