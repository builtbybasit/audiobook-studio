// Endpoint configuration (speech, scripting profiles, transcription, credentials) at this tab's
// API; past requests are `@/services/usage`. It travels as one document: the page binds fields
// straight onto objects, and the server checks the lists against each other (a named credential
// must be in the same body), which a partial write could not allow.
import type {
  ClonedVoice,
  Credential,
  Endpoint,
  EndpointKind,
  EndpointLive,
  EndpointBatches,
  EndpointProbe,
  KeptVoiceSamples,
  Profile,
  PromptTemplate,
  ScriptSettings,
  Transcriber,
  VoiceListPage,
  VoiceRef,
  VoiceSpeedLines,
  VoiceSpeedRedone,
} from "@/types";
import type { StoredEndpoint } from "@/lib/endpointTelemetry";
import { HttpClient, seg, type FetchLike } from "@/services/http";
import { API_BASE } from "@/services/mode";

export type { EndpointProbe, VoiceListPage } from "@/types";

/** What is sent: the whole configuration, replacing what the server holds. */
export interface EndpointConfig {
  endpoints: StoredEndpoint[];
  profiles: Profile[];
  /** Always sent: left out, the server keeps what it holds. */
  transcribers: Transcriber[];
  credentials: Credential[];
  /**
   * null is the built-in prompt. Left out of a write, the server keeps its own; always in a read.
   */
  prompt?: PromptTemplate | null;
  /** The profile runs go to, and its switches. Left out of a write, the server keeps its own. */
  script?: ScriptSettings;
}

/** Endpoints come back with empty telemetry (request history is this browser's). */
export interface EndpointSettings extends EndpointConfig {
  endpoints: Endpoint[];
}

/** Which of a speech endpoint's catalogues to read. Only Fish Audio has a public one. */
export interface VoiceListQuery {
  /** `library`: every voice the account holds; `public`: one page of a search */
  source: "library" | "public";
  /** words in a voice's title, or a Fish voice id to find that one voice */
  query?: string;
  /** a language code the voices must speak, e.g. `en` */
  language?: string;
  /** 1-based */
  page?: number;
}

/** One voice saying the server's sample sentence. */
export interface VoiceSample {
  blob: Blob;
  /** seconds, when the server knows */
  duration: number | null;
  /** the provider's own recording of the voice, or the endpoint saying the sample sentence */
  source: "recording" | "rendered";
}

export interface EndpointSettingsService {
  getSettings(): Promise<EndpointSettings>;
  /**
   * Refused whole when any part doesn't hold together. `apiKey` is write-only: left out, the server
   * keeps its key; `""` forgets it. The store sends it on one entry, only when a key was typed.
   */
  putSettings(body: EndpointConfig): Promise<EndpointSettings>;
  /** Test the *saved* endpoint, with the key the server holds for it. */
  testEndpoint(kind: EndpointKind, id: string): Promise<EndpointProbe>;
  /** Ask the *saved* speech endpoint's server, with the key it holds, whether it takes batches. */
  batchLimits(id: string): Promise<EndpointBatches>;
  /** Ask the *saved* speech endpoint, with the key the server holds, what voices it offers. */
  listVoices(id: string, query: VoiceListQuery): Promise<VoiceListPage>;
  /** Have the *saved* speech endpoint say `text` (else the default line) in one voice. Priced. */
  sampleVoice(id: string, voice: string, text?: string): Promise<VoiceSample>;
  /** One recording a voice was made from, as kept on the server. */
  keptSampleFile(id: string, voice: string, file: string): Promise<Blob>;
  /** Clone on the *saved* endpoint's provider; the server keeps the samples and says if it did. */
  cloneVoice(id: string, request: VoiceCloneRequest): Promise<ClonedVoice>;
  /** Delete a voice on the *saved* endpoint's server, for good. */
  deleteVoice(id: string, voice: string): Promise<void>;
  /** Every voice of the *saved* endpoint whose samples are kept. */
  keptSamples(id: string): Promise<KeptVoiceSamples[]>;
  /** Keep samples for a voice cloned before samples were kept. Nothing is sent to the provider. */
  keepSamples(
    id: string,
    voice: string,
    request: Omit<VoiceCloneRequest, "title">,
  ): Promise<KeptVoiceSamples>;
  /** On transcriber `id`, or the first enabled one. A real request, priced by the minute sent. */
  transcribe(file: File, id?: string): Promise<{ text: string }>;
  /**
   * The server process's telemetry per speech endpoint (lines out and held, rate limits, cooldown).
   * An endpoint absent from the answer has had nothing sent since the server started.
   */
  live(): Promise<Record<string, EndpointLive>>;
  /** After a voice's speed changed: every book's lines still at the old one. */
  voiceSpeedLines(ref: VoiceRef): Promise<VoiceSpeedLines>;
  /** Re-narrate (sent) and Re-apply (made here) those lines in `books`. */
  redoVoiceSpeed(ref: VoiceRef, books: string[]): Promise<VoiceSpeedRedone>;
  /** The made-here lines in `books` keep the old sound; how many. */
  keepVoiceSpeed(ref: VoiceRef, books: string[]): Promise<number>;
}

export interface VoiceCloneRequest {
  title: string;
  samples: File[];
  /** in sample order; "" or absent where the person gave none */
  transcripts?: string[];
}

export class HttpEndpointSettingsService implements EndpointSettingsService {
  private readonly http: HttpClient;
  constructor(base = API_BASE, fetch?: FetchLike) {
    this.http = new HttpClient(base, fetch);
  }

  getSettings(): Promise<EndpointSettings> {
    return this.http.get<EndpointSettings>("/endpoints");
  }

  putSettings(body: EndpointConfig): Promise<EndpointSettings> {
    return this.http.put<EndpointSettings>("/endpoints", body);
  }

  testEndpoint(kind: EndpointKind, id: string): Promise<EndpointProbe> {
    return this.http.post<EndpointProbe>("/endpoints/test", { kind, id });
  }

  voiceSpeedLines(ref: VoiceRef): Promise<VoiceSpeedLines> {
    return this.http.post<VoiceSpeedLines>("/endpoints/voice-speed/old", { ref });
  }

  redoVoiceSpeed(ref: VoiceRef, books: string[]): Promise<VoiceSpeedRedone> {
    return this.http.post<VoiceSpeedRedone>("/endpoints/voice-speed/redo", { ref, books });
  }

  async keepVoiceSpeed(ref: VoiceRef, books: string[]): Promise<number> {
    const answer = await this.http.post<{ kept: number }>("/endpoints/voice-speed/keep", {
      ref,
      books,
    });
    return answer.kept;
  }

  batchLimits(id: string): Promise<EndpointBatches> {
    return this.http.post<EndpointBatches>("/endpoints/batch", { id });
  }

  listVoices(id: string, query: VoiceListQuery): Promise<VoiceListPage> {
    return this.http.post<VoiceListPage>("/endpoints/voices", { id, ...query });
  }

  cloneVoice(id: string, request: VoiceCloneRequest): Promise<ClonedVoice> {
    const form = samplesForm(request);
    form.set("id", id);
    form.set("title", request.title.trim());
    return this.http.postFormData<ClonedVoice>("/endpoints/voices/clone", form);
  }

  async deleteVoice(id: string, voice: string): Promise<void> {
    await this.http.delete<null>(`/endpoints/${seg(id)}/voices/${seg(voice)}`);
  }

  transcribe(file: File, id?: string): Promise<{ text: string }> {
    const form = new FormData();
    form.set("file", file, file.name);
    if (id) form.set("id", id);
    return this.http.postFormData<{ text: string }>("/endpoints/transcribe", form);
  }

  keptSamples(id: string): Promise<KeptVoiceSamples[]> {
    return this.http.get<KeptVoiceSamples[]>(`/endpoints/${seg(id)}/samples`);
  }

  keepSamples(
    id: string,
    voice: string,
    request: Omit<VoiceCloneRequest, "title">,
  ): Promise<KeptVoiceSamples> {
    return this.http.postFormData<KeptVoiceSamples>(samplesPath(id, voice), samplesForm(request));
  }

  async live(): Promise<Record<string, EndpointLive>> {
    return (await this.http.get<{ endpoints: Record<string, EndpointLive> }>("/endpoints/live"))
      .endpoints;
  }

  keptSampleFile(id: string, voice: string, file: string): Promise<Blob> {
    return this.http.getBlob(`${samplesPath(id, voice)}/${seg(file)}`);
  }

  async sampleVoice(id: string, voice: string, text?: string): Promise<VoiceSample> {
    const { blob, headers } = await this.http.postForFile("/endpoints/sample", {
      id,
      voice,
      ...(text ? { text } : {}),
    });
    return {
      blob,
      duration: Number(headers.get("x-audio-duration")) || null,
      source: headers.get("x-sample-source") === "recording" ? "recording" : "rendered",
    };
  }
}

const samplesPath = (id: string, voice: string) =>
  `/endpoints/${seg(id)}/voices/${seg(voice)}/samples`;

/** One `samples` file and one `transcripts` text per sample, in the same order. */
function samplesForm(request: Omit<VoiceCloneRequest, "title">): FormData {
  const form = new FormData();
  for (const [i, sample] of request.samples.entries()) {
    form.append("samples", sample, sample.name);
    form.append("transcripts", request.transcripts?.[i] ?? "");
  }
  return form;
}

let service: EndpointSettingsService | null = null;

/** The one a test set, or the HTTP one for this tab's library. */
export function endpointSettingsService(): EndpointSettingsService {
  return (service ??= new HttpEndpointSettingsService());
}

/** For tests and startup wiring. Set it before the endpoints store loads. */
export function setEndpointSettingsService(next: EndpointSettingsService | null): void {
  service = next;
}

/** The key is the server's; the browser only learns that one is held (`hasKey`). */
export function keyInPlace(entry: { hasKey?: boolean } | null | undefined): boolean {
  return !!entry?.hasKey;
}
