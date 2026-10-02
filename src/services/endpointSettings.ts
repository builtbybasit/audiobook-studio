// Where the endpoints are configured: the speech endpoints, the scripting profiles, and the named
// credentials they point at.
//
// The same arrangement as `@/services/library`: one HTTP implementation, answering at this tab's
// API — your library's, or the demo's. This is not `@/services/usage`, which answers for the *past*
// requests the Endpoints page charts; this is the configuration a narration job on the server reads
// to know what to call.
//
// The whole configuration travels as one document. The page binds its fields straight onto the
// objects it edits, so there is no single action to hang a narrower request on — and the server
// has to check the three lists against each other anyway (a credential an endpoint names must be
// in the same body), which a partial write could not let it do.
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
  VoiceListPage,
} from "@/types";
import type { StoredEndpoint } from "@/lib/endpointTelemetry";
import { HttpClient, seg, type FetchLike } from "@/services/http";
import { API_BASE } from "@/services/mode";

// declared in `@/types` with the server that answers them; named here too for the page that reads
// them beside the service
export type { EndpointProbe, VoiceListPage } from "@/types";

/** What is sent: the whole configuration, replacing what the server holds. */
export interface EndpointConfig {
  endpoints: StoredEndpoint[];
  profiles: Profile[];
  credentials: Credential[];
  /**
   * The library's default scripting prompt; null is the built-in one. Optional in a write, where
   * leaving it out keeps what the server holds; always present in a read.
   */
  prompt?: PromptTemplate | null;
  /**
   * The scripting settings — the profile runs go to, and the switches beside it. Optional in a
   * write, where leaving them out keeps what the server holds; always present in a read.
   */
  script?: ScriptSettings;
}

/**
 * The configuration as the server holds it. Endpoints come back with their telemetry empty — the
 * request history is this browser's, not something the server keeps. A server nobody has saved to
 * answers with empty lists.
 */
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

/** One voice saying the server's sample sentence: the audio as the endpoint answered, and its length. */
export interface VoiceSample {
  blob: Blob;
  /** seconds, when the server knows; a provider's own recording is timed by the file */
  duration: number | null;
  /** the provider's own recording of the voice, or the endpoint saying the sample sentence */
  source: "recording" | "rendered";
}

export interface EndpointSettingsService {
  getSettings(): Promise<EndpointSettings>;
  /**
   * Replace the whole configuration. Refused whole when any part of it does not hold together.
   *
   * An entry's `apiKey` is the one write-only field: left out, the server keeps the key it holds;
   * `""` forgets it. The store puts it on exactly one entry, and only when a key was typed.
   */
  putSettings(body: EndpointConfig): Promise<EndpointSettings>;
  /** Test the *saved* endpoint, with the key the server holds for it. */
  testEndpoint(kind: EndpointKind, id: string): Promise<EndpointProbe>;
  /** Ask the *saved* speech endpoint's server, with the key it holds, whether it takes batches. */
  batchLimits(id: string): Promise<EndpointBatches>;
  /** Ask the *saved* speech endpoint, with the key the server holds, what voices it offers. */
  listVoices(id: string, query: VoiceListQuery): Promise<VoiceListPage>;
  /** Have the *saved* speech endpoint say a sentence in one voice. A real, priced request. */
  sampleVoice(id: string, voice: string): Promise<VoiceSample>;
  /**
   * Make a voice from samples on the *saved* endpoint's provider, with the key the server holds.
   * The server keeps the samples with the voice, and says whether it managed to.
   */
  cloneVoice(id: string, request: VoiceCloneRequest): Promise<ClonedVoice>;
  /** Every voice of the *saved* endpoint whose samples are kept. */
  keptSamples(id: string): Promise<KeptVoiceSamples[]>;
  /**
   * Keep samples for a voice already on the *saved* endpoint, in place of any it had — for a
   * voice cloned before samples were kept. Nothing is sent to the provider.
   */
  keepSamples(
    id: string,
    voice: string,
    request: Omit<VoiceCloneRequest, "title">,
  ): Promise<KeptVoiceSamples>;
  /** Forget one voice's kept samples; the voice stays. */
  forgetSamples(id: string, voice: string): Promise<void>;
  /** Take back a forget no save has made final yet; answers with the samples. */
  restoreSamples(id: string, voice: string): Promise<KeptVoiceSamples>;
  /**
   * What the server's process has seen of each speech endpoint it has sent to: lines out and held,
   * rate limits, the end of a cooldown. Not configuration, but the telemetry the configuration
   * comes back without, which is why it is asked for here. An endpoint absent from the answer has
   * had nothing sent to it since the server started.
   */
  live(): Promise<Record<string, EndpointLive>>;
}

/** What a voice is made from: a name and the samples. */
export interface VoiceCloneRequest {
  title: string;
  samples: File[];
  /** what is said in each sample, in the same order; "" or absent where the person gave none */
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

  async forgetSamples(id: string, voice: string): Promise<void> {
    await this.http.delete<null>(samplesPath(id, voice));
  }

  restoreSamples(id: string, voice: string): Promise<KeptVoiceSamples> {
    return this.http.post<KeptVoiceSamples>(`${samplesPath(id, voice)}/restore`);
  }

  async live(): Promise<Record<string, EndpointLive>> {
    return (await this.http.get<{ endpoints: Record<string, EndpointLive> }>("/endpoints/live"))
      .endpoints;
  }

  async sampleVoice(id: string, voice: string): Promise<VoiceSample> {
    const { blob, headers } = await this.http.postForFile("/endpoints/sample", { id, voice });
    return {
      blob,
      duration: Number(headers.get("x-audio-duration")) || null,
      source: headers.get("x-sample-source") === "recording" ? "recording" : "rendered",
    };
  }
}

const samplesPath = (id: string, voice: string) =>
  `/endpoints/${seg(id)}/voices/${seg(voice)}/samples`;

/**
 * The samples and their transcripts as the server reads them: a `samples` file and a `transcripts`
 * text per sample, in the same order.
 */
function samplesForm(request: Omit<VoiceCloneRequest, "title">): FormData {
  const form = new FormData();
  for (const [i, sample] of request.samples.entries()) {
    form.append("samples", sample, sample.name);
    form.append("transcripts", request.transcripts?.[i] ?? "");
  }
  return form;
}

let service: EndpointSettingsService | null = null;

/** The endpoint settings service: the one a test set, or the HTTP one for this tab's library. */
export function endpointSettingsService(): EndpointSettingsService {
  return (service ??= new HttpEndpointSettingsService());
}

/** For tests and for wiring at startup. Set it before the endpoints store loads. */
export function setEndpointSettingsService(next: EndpointSettingsService | null): void {
  service = next;
}

/**
 * Whether the key an endpoint or profile needs is in place, for every "no key" warning and gate.
 * The key is the server's, and the browser only ever learns that one is held (`hasKey`).
 */
export function keyInPlace(entry: { hasKey?: boolean } | null | undefined): boolean {
  return !!entry?.hasKey;
}
