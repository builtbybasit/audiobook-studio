// Making a voice from samples, and keeping the samples a voice was made from: what the clone route
// and the keep route ask for, from the form's files to the kept rows.
//
// The endpoint is read once, and with it what its provider makes a voice from (`cloning`); every
// sample is held to that before anything is sent or kept, and refused in the words the Voices tab
// says the same limits in (`lib/voiceSamples.ts`). A sample is what its first bytes say it is
// (`sniffSample`) — its name and the type the browser gave it are only guesses, and reading the
// whole of it to find out would be a copy of every sample.
//
// The samples are kept once the provider has answered — never before, so a failed clone keeps
// nothing — beside the consent they were given under, so the voice can travel with a book's script.
// The voice already exists on the account by then, so a failure to keep them is not a failure to
// clone: the answer says `samplesKept: false`, and the page says so.
import type { ClonedVoice, KeptVoiceSamples } from "@/types";
import { cloneModelsFor, cloningOf, type CloneSupport } from "@/lib/providers";
import {
  formatsHint,
  MAX_TRANSCRIPT_CHARS,
  maxSampleBytesOf,
  maxSamplesOf,
  noTranscriptSaid,
  tooLargeSaid,
  tooManySaid,
  transcriptTooLongSaid,
  wrongFormatSaid,
} from "@/lib/voiceSamples";
import type { Db } from "~/db/client";
import { readEndpoint } from "~/db/endpoints";
import { providerFailure } from "~/endpoints/ops";
import { badRequest, fail, notFound } from "~/lib/errors";
import {
  endpointVoiceCloner,
  SAMPLE_HEAD_BYTES,
  SAMPLE_MIME,
  sniffSample,
  type SampleUpload,
} from "~/providers/clone";
import { ProviderError } from "~/providers/http";
import { speechTarget, type Providers } from "~/providers/target";
import { settleClone } from "~/usage/ledger";
import type { VoiceFiles } from "~/voices/files";
import { keepSampleFiles, keptOf } from "~/voices/ops";

/** A saved speech endpoint that can make a voice, or the refusal that says why it cannot. */
function clonableEndpoint(db: Db, id: string) {
  const ep = readEndpoint(db, id);
  if (!ep) throw notFound("There is no saved speech endpoint by that id", `id: ${id}`);
  const cloning = cloningOf(ep);
  if (cloning) return { ...ep, cloning };
  const models = cloneModelsFor(ep);
  throw badRequest(
    models.length
      ? `${ep.name} cannot make a voice with the model ${ep.model}; change its model to ${models.join(" or ")} first`
      : `${ep.name} cannot make a voice from samples`,
  );
}

/**
 * The form's files, each typed by what its first bytes say it is and held to what the provider
 * takes: how many, how large, which formats, and — where it needs one — a transcript, the
 * `transcripts` field beside each file. Refused with the file's own name.
 */
export async function readSamples(
  files: File[],
  transcripts: string[],
  cloning: CloneSupport,
): Promise<SampleUpload[]> {
  if (!files.length) fail(400, "Add at least one sample of the voice");
  if (files.length > maxSamplesOf(cloning)) fail(400, tooManySaid(cloning));
  const samples: SampleUpload[] = [];
  for (const [i, f] of files.entries()) {
    // a file can reach the form without a name, and a refusal still has to say which one
    const named = f.name || "One of the samples";
    if (f.size > maxSampleBytesOf(cloning)) fail(413, tooLargeSaid(named, cloning));
    if (!f.size) fail(400, `${named} is empty`);
    const transcript = cloning.transcript === "none" ? "" : (transcripts[i] ?? "").trim();
    if (cloning.transcript === "required" && !transcript) fail(400, noTranscriptSaid(named));
    if (transcript.length > MAX_TRANSCRIPT_CHARS) fail(400, transcriptTooLongSaid(named));
    const head = await f.slice(0, SAMPLE_HEAD_BYTES).arrayBuffer();
    const format = sniffSample(new Uint8Array(head));
    if (!format) fail(415, `${named} is not audio a voice can be made from`, formatsHint(cloning));
    if (!cloning.formats.includes(format))
      fail(415, wrongFormatSaid(named, format), formatsHint(cloning));
    // the parsed file itself, typed by its bytes: a slice is a view, not a copy
    samples.push({
      name: f.name || `sample.${format}`,
      blob: f.slice(0, f.size, SAMPLE_MIME[format]),
      format,
      ...(transcript ? { transcript } : {}),
    });
  }
  return samples;
}

export interface CloneForm {
  endpointId: string;
  title: string;
  consentText: string;
  files: File[];
  /** what is said in each file, in the files' order; "" where the person gave none */
  transcripts: string[];
}

/** What a clone came to: the voice, and how many samples it was made from. */
export interface Cloned {
  voice: ClonedVoice;
  samples: number;
  /** why the samples were not kept, for the log; absent when they were */
  keepError?: unknown;
}

/**
 * A voice made on a saved speech endpoint's provider, with its saved key, from the form's samples,
 * and the samples kept with it. Answered as the voice the page then adds to the endpoint.
 */
export async function cloneVoice(
  db: Db,
  providers: Providers,
  voiceFiles: VoiceFiles,
  form: CloneForm,
  signal: AbortSignal,
): Promise<Cloned> {
  const ep = clonableEndpoint(db, form.endpointId);
  const samples = await readSamples(form.files, form.transcripts, ep.cloning);
  const cloner = providers.cloner ?? endpointVoiceCloner();
  let voice;
  try {
    voice = await cloner.clone(speechTarget(db, ep), { title: form.title, samples }, signal);
  } catch (e) {
    throw e instanceof ProviderError ? providerFailure(e) : e;
  }
  const { warning, ...made } = voice;
  // the voice exists on the account now, and costs what its provider charges for one
  settleClone(db, ep, { id: made.id, title: form.title }, ep.cloning.fee);
  try {
    await keepSampleFiles(db, voiceFiles, {
      endpointId: ep.id,
      voiceId: made.id,
      title: form.title,
      consentText: form.consentText,
      samples,
      attached: false,
    });
  } catch (keepError) {
    return {
      voice: { ...made, samplesKept: false, ...(warning ? { warning } : {}) },
      samples: samples.length,
      keepError,
    };
  }
  return {
    voice: { ...made, samplesKept: true, ...(warning ? { warning } : {}) },
    samples: samples.length,
  };
}

/**
 * Give a voice already on a saved endpoint the samples it was made from, in place of any it had —
 * for a voice cloned before samples were kept. Held to the same limits as a clone on that endpoint;
 * nothing is sent to the provider.
 */
export async function keepForVoice(
  db: Db,
  voiceFiles: VoiceFiles,
  request: Omit<CloneForm, "title"> & { voiceId: string },
): Promise<KeptVoiceSamples> {
  const ep = clonableEndpoint(db, request.endpointId);
  const voice = ep.voices.find((v) => v.id === request.voiceId);
  if (!voice)
    throw notFound(`${ep.name} has no saved voice by that id`, `voice: ${request.voiceId}`);
  const samples = await readSamples(request.files, request.transcripts, ep.cloning);
  await keepSampleFiles(db, voiceFiles, {
    endpointId: ep.id,
    voiceId: voice.id,
    title: voice.label,
    consentText: request.consentText,
    samples,
    attached: true,
  });
  return keptOf(db, ep.id, voice.id);
}
