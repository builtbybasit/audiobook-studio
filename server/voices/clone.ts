// Making a voice from samples, and keeping the samples it was made from. Samples are held to the
// provider's `cloning` limits, in the Voices tab's words (`lib/voiceSamples.ts`), and sniffed from
// their bytes. They are kept only after the provider answers; a failure to keep is not a failure
// to clone (`samplesKept: false`). A clone cancelled after upload is billed at unknown cost.
import type { ClonedVoice, KeptVoiceSamples } from "@/types";
import { cloneModelsFor, cloningOf, speechProviderOf, type CloneSupport } from "@/lib/providers";
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
import { assertWithinBudget } from "~/usage/budget";
import { settleCancelledClone, settleClone } from "~/usage/ledger";
import type { VoiceFiles } from "~/voices/files";
import { keepSampleFiles, keptOf } from "~/voices/ops";

function clonableEndpoint(db: Db, id: string) {
  const ep = readEndpoint(db, id);
  if (!ep) throw notFound("There is no saved speech endpoint by that id", `id: ${id}`);
  const cloning = cloningOf(ep);
  if (cloning) return { ...ep, cloning };
  const models = cloneModelsFor(ep);
  throw badRequest(
    models.length
      ? `${ep.name} cannot make a voice with the model ${ep.model}; change its model to ${models.join(" or ")} first`
      : speechProviderOf(ep).cloning?.optIn
        ? `${ep.name} does not say its server makes voices; turn that on on its Voices tab first`
        : `${ep.name} cannot make a voice from samples`,
  );
}

/** Refusals name the file. */
export async function readSamples(
  files: File[],
  transcripts: string[],
  cloning: CloneSupport,
): Promise<SampleUpload[]> {
  if (!files.length) fail(400, "Add at least one sample of the voice");
  if (files.length > maxSamplesOf(cloning)) fail(400, tooManySaid(cloning));
  const samples: SampleUpload[] = [];
  for (const [i, f] of files.entries()) {
    // a file can arrive without a name
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
    // a slice is a view, not a copy
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
  files: File[];
  /** in the files' order; "" where none was given */
  transcripts: string[];
}

export interface Cloned {
  voice: ClonedVoice;
  samples: number;
  /** for the log; absent when the samples were kept */
  keepError?: unknown;
}

export async function cloneVoice(
  db: Db,
  providers: Providers,
  voiceFiles: VoiceFiles,
  form: CloneForm,
  signal: AbortSignal,
): Promise<Cloned> {
  const ep = clonableEndpoint(db, form.endpointId);
  // a fee charged on making is held to the endpoint's daily limit
  const fee = ep.cloning.fee?.when === "made" ? (ep.cloning.fee.usd ?? 0) : 0;
  assertWithinBudget(db, null, {
    kind: "narration",
    cost: fee,
    requests: [{ endpoint: ep.id, cost: fee }],
    request: "this voice's fee",
  });
  const samples = await readSamples(form.files, form.transcripts, ep.cloning);
  const cloner = providers.cloner ?? endpointVoiceCloner();
  let voice;
  let wentOut = false;
  try {
    voice = await cloner.clone(
      speechTarget(db, ep),
      { title: form.title, samples },
      signal,
      () => void (wentOut = true),
    );
  } catch (e) {
    // cancelled after upload: the voice may have been made, and charged for
    if (signal.aborted && wentOut) settleCancelledClone(db, ep, form.title, ep.cloning.fee);
    throw e instanceof ProviderError ? providerFailure(e) : e;
  }
  const { warning, ...made } = voice;
  settleClone(db, ep, { id: made.id, title: form.title }, ep.cloning.fee);
  try {
    await keepSampleFiles(db, voiceFiles, {
      endpointId: ep.id,
      voiceId: made.id,
      title: form.title,
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

/** Replaces an existing voice's kept samples, held to the same limits; nothing is sent. */
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
    samples,
    attached: true,
  });
  return keptOf(db, ep.id, voice.id);
}
