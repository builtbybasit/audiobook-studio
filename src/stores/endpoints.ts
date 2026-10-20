// Provider configurations and voice catalogues. The server keeps each key; this store only holds
// `hasKey`, and a typed key goes out in one write (`saveKey`).
// The page binds fields straight onto these objects, so the store writes behind: it watches the
// configuration as one document and sends the whole of it shortly after it last changed. Telemetry
// (live counts, rate limits, cooldown) is left out of what it watches, so a poll never saves.
import { nextTick, watch } from "vue";
import { useQueryCache } from "@pinia/colada";
import {
  ensureOps,
  isFishAudio,
  presetById,
  transcriberErrors,
  transcriptionPresetById,
  voiceRef,
} from "@/lib/endpoints";
import { ensurePricing } from "@/lib/pricing";
import { cloningOf } from "@/lib/providers";
import { configErrors, expressionId, withBrackets } from "@/lib/expressions";
import { newProfile, profileErrors } from "@/lib/scripting";
import { BUILT_IN_PROMPT, profilePromptProblems, promptProblems } from "@/lib/prompt";
import { GENDER } from "@/lib/scriptReview";
import { clone } from "@/lib/utils";
import { ENDPOINT_TELEMETRY, type StoredEndpoint } from "@/lib/endpointTelemetry";
import {
  endpointSettingsService,
  type EndpointConfig,
  type EndpointSettings,
  type EndpointSettingsService,
  type VoiceCloneRequest,
  type VoiceListPage,
  type VoiceListQuery,
} from "@/services/endpointSettings";
import { ApiError } from "@/services/http";
import { invalidate } from "@/queries/invalidate";
import { keys } from "@/queries/keys";
import { encodingOf } from "@/lib/endpointShapes";
import type {
  BatchLimits,
  ConnectionTest,
  Credential,
  Endpoint,
  EndpointKind,
  EndpointLive,
  ExpressionConfig,
  KeptVoiceSamples,
  Profile,
  ProfilePrompt,
  PromptTemplate,
  ResolvedVoice,
  ScriptSettings,
  SettingsFile,
  Transcriber,
  Voice,
  VoiceOption,
  VoiceRef,
} from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "@/stores/cast";
import { useExistingLinesStore } from "@/stores/existingLines";
import { useJobsStore } from "@/stores/jobs";
import { useNarrationStore } from "@/stores/narration";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { toastFailure } from "@/stores/toastFailure";
import { useUiStore } from "@/stores/ui";
interface EndpointsState {
  endpoints: Endpoint[];
  profiles: Profile[];
  transcribers: Transcriber[];
  /** The library's default scripting prompt; null is the built-in one. */
  prompt: PromptTemplate | null;
  /** Credential names the endpoints and profiles use; never a key. */
  credentials: Credential[];
  loaded: boolean;
}

const IDLE: EndpointLive = { active: 0, waiting: 0, rateLimits: 0, backoffUntil: 0 };
const NONE: Record<string, EndpointLive> = {};

/** How long the configuration sits still before it is sent, so typing sends nothing per key. */
export const WRITE_DELAY_MS = 400;

const telemetry = new Set<string>(ENDPOINT_TELEMETRY);

function storedOf(ep: Endpoint): StoredEndpoint {
  // Key by key, not a rest spread: a spread reads every field, so the watch would rerun on every
  // request an endpoint records.
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(ep))
    if (!telemetry.has(k) && k !== "apiKey") out[k] = ep[k as keyof Endpoint];
  return out as unknown as StoredEndpoint;
}

function configOf(
  state: Pick<EndpointsState, "endpoints" | "profiles" | "transcribers" | "prompt" | "credentials">,
  script: ScriptSettings,
): EndpointConfig {
  const { endpoints, profiles, transcribers, prompt, credentials } = state;
  return {
    endpoints: endpoints.map(storedOf),
    // `apiKey` is dropped: a stray key would go out with every write-behind, and a stale `""`
    // would forget it
    profiles: profiles.map(({ apiKey: _apiKey, ...p }) => p),
    transcribers: transcribers.map(({ apiKey: _apiKey, ...t }) => t),
    credentials: credentials.map((c) => ({ ...c })),
    prompt,
    // the profile named is always one saved with it; the server insists
    script: {
      ...script,
      profile: profiles.some((p) => p.id === script.profile) ? script.profile : null,
    },
  };
}

const LIST: Record<EndpointKind, "profiles" | "endpoints" | "transcribers"> = {
  scripting: "profiles",
  tts: "endpoints",
  transcription: "transcribers",
};

const entriesOf = (
  doc: Pick<EndpointConfig, "profiles" | "endpoints" | "transcribers">,
  kind: EndpointKind,
): { id: string; apiKey?: string; hasKey?: boolean }[] => doc[LIST[kind]];

/**
 * Fills in operational settings and pricing for an entry saved before they existed. Every entry
 * the store takes on passes through here. Idempotent; the defaults change no request.
 */
function filled<T extends Endpoint | Profile | Transcriber>(ep: T, kind: EndpointKind): T {
  ensureOps(ep, kind);
  ensurePricing(ep);
  return ep;
}

/** Null when the template is the built-in prompt word for word. */
function keptPrompt(t: PromptTemplate | null): PromptTemplate | null {
  return !t || (t.system === BUILT_IN_PROMPT.system && t.user === BUILT_IN_PROMPT.user)
    ? null
    : { system: t.system, user: t.user };
}

/** Whether a settings file's default prompt is null or a whole prompt. */
function promptOk(t: unknown): t is PromptTemplate | null {
  if (t === null) return true;
  const o = t as Partial<PromptTemplate> | undefined;
  return (
    typeof o?.system === "string" &&
    typeof o.user === "string" &&
    !promptProblems({ system: o.system, user: o.user }).length
  );
}

/** Drops the key and `hasKey` from an entry for a settings file. */
function portable<T extends { apiKey?: string; hasKey?: boolean }>(e: T): T {
  const { apiKey: _apiKey, hasKey: _hasKey, ...rest } = e;
  return rest as T;
}

/**
 * Takes on the server's fields while keeping the object, since the page holds references to it.
 * A field the server did not send is gone; telemetry is never the server's to change.
 */
function adopt<T extends object>(cur: T, next: T): T {
  const target = cur as Record<string, unknown>;
  const source = next as Record<string, unknown>;
  for (const k of Object.keys(target)) if (!telemetry.has(k) && !(k in source)) delete target[k];
  for (const k of Object.keys(source)) if (!telemetry.has(k)) target[k] = source[k];
  return cur;
}

// Write-behind bookkeeping (module state, not rendered). Only one whole-configuration write is ever
// out: two could land in either order. A change made meanwhile goes in one write owed after it,
// built from the configuration as it stands when sent, never a queue of old copies.
/** Local changes seen so far. A write's answer is installed only if none came after it. */
let edits = 0;
/** A write is out, so the server may soon hold something other than `held`. Lowered before an
 *  answer is installed, so the watch does not send it back. */
let sending = false;
/** The configuration as the server last described it, serialized. */
let held = "";
let timer: ReturnType<typeof setTimeout> | null = null;
let out: Promise<SaveOutcome> | null = null;
/** The write owed once `out` is done, for changes made while it was out. */
let next: Promise<SaveOutcome> | null = null;
/** Keys to ride on the next write, by `<kind>:<id>`; each goes out once. */
const keysWaiting = new Map<string, { kind: EndpointKind; id: string; apiKey: string }>();
let stopWatch: (() => void) | null = null;
/** The store the watch is on, held weakly; a second Pinia (a test's next tab) takes it over. */
let watching: WeakRef<object> | null = null;

export type SaveOutcome = "landed" | "refused";

/** A voice heard, as an object url; `duration` is null when only the file knows it. */
export interface HeardSample {
  url: string;
  duration: number | null;
  source: "recording" | "rendered";
}

/**
 * Voice samples heard this session, by what they were rendered with. The server keeps them too;
 * this only saves the round trip.
 */
const samples = new Map<string, HeardSample>();
const sampleKey = (ep: Endpoint, voiceId: string, text = ""): string =>
  JSON.stringify([
    ep.id,
    ep.baseUrl,
    ep.model,
    encodingOf(ep),
    ep.sampleRate ?? null,
    voiceId,
    ep.voices.find((v) => v.id === voiceId)?.speed ?? 1,
    text,
  ]);
/** Object urls of the recordings voices were made from, by endpoint, voice and file. */
const sources = new Map<string, string>();

/** Off, and priced as free until a rate is set. */
const blankTranscriber = (): Transcriber => ({
  id: "stt" + Date.now(),
  name: "New endpoint",
  baseUrl: "https://",
  model: "whisper-1",
  concurrency: 1,
  enabled: false,
  needsKey: true,
  perMinute: 0,
});

function cancelTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

export const useEndpointsStore = defineStore("endpoints", {
  state: (): EndpointsState => ({
    endpoints: [],
    profiles: [],
    transcribers: [],
    prompt: null,
    credentials: [],
    loaded: false,
  }),
  getters: {
    /** Per-endpoint telemetry from the server (`useEndpointLive`). Empty until narration runs. */
    live(): Record<string, EndpointLive> {
      return useQueryCache().getQueryData<Record<string, EndpointLive>>(keys.endpointLive) ?? NONE;
    },
    /** Lines out and held at a speech endpoint across every job, as the server's gate counts them. */
    serverLoad(): (id: string) => EndpointLive {
      return (id) => this.live[id] ?? IDLE;
    },
    enabledEndpoints(s): Endpoint[] {
      return s.endpoints.filter((e) => e.enabled);
    },
    canTranscribe(s): boolean {
      return s.transcribers.some((t) => t.enabled);
    },
    /**
     * The endpoint a voice ref names, listed voice or not: where a line in that voice is sent
     * (`deliveryFor` on the server). Null when it names none saved.
     */
    endpointOf(s): (ref: string | null | undefined) => Endpoint | null {
      return (ref) => {
        const i = ref?.indexOf("/") ?? -1;
        return (i > 0 && s.endpoints.find((e) => e.id === ref!.slice(0, i))) || null;
      };
    },
    resolveVoice(): (ref: string | null | undefined) => ResolvedVoice | null {
      return (ref: VoiceRef | null | undefined): ResolvedVoice | null => {
        const ep = this.endpointOf(ref);
        const v = ep?.voices.find((v) => v.id === ref!.slice(ref!.indexOf("/") + 1));
        return ep && v ? { endpoint: ep, voice: v } : null;
      };
    },
    voiceLabel(): (ref: VoiceRef | null | undefined) => string {
      return (ref) => {
        const r = this.resolveVoice(ref);
        return r
          ? `${r.voice.label} · ${r.endpoint.name}`
          : ref
            ? `${ref.split("/")[1]} (missing)`
            : "";
      };
    },
    voiceOptions(s): VoiceOption[] {
      return s.endpoints.flatMap((e) =>
        e.voices.map((v) => ({
          value: voiceRef(e.id, v.id),
          label: v.label,
          group: e.enabled ? e.name : `${e.name} · paused`,
          hint: GENDER[v.gender] ?? "",
          disabled: !e.enabled,
        })),
      );
    },
  },
  actions: {
    // ---------- the seam ----------
    _service(): EndpointSettingsService {
      return endpointSettingsService();
    },
    _config(): EndpointConfig {
      return configOf(this, useScriptingStore().scriptSettings);
    },
    /** Hold the server's answer. A surviving endpoint keeps its object and telemetry. */
    _install(answer: EndpointSettings): void {
      const endpoints = new Map(this.endpoints.map((e) => [e.id, e]));
      this.endpoints = answer.endpoints.map((e) => {
        const cur = endpoints.get(e.id);
        return filled(
          cur ? adopt(cur, e) : { ...e, history: [], failures: 0, rateLimits: 0, backoffUntil: 0 },
          "tts",
        );
      });
      const profiles = new Map(this.profiles.map((p) => [p.id, p]));
      this.profiles = answer.profiles.map((p) => {
        const cur = profiles.get(p.id);
        return filled(cur ? adopt(cur, p) : p, "scripting");
      });
      const transcribers = new Map(this.transcribers.map((t) => [t.id, t]));
      this.transcribers = answer.transcribers.map((t) => {
        const cur = transcribers.get(t.id);
        return filled(cur ? adopt(cur, t) : t, "transcription");
      });
      this.credentials = answer.credentials;
      this.prompt = answer.prompt ?? null;
      if (answer.script) useScriptingStore().scriptSettings = { ...answer.script };
      // the answer is not a change to send
      held = JSON.stringify(this._config());
    },
    /**
     * Puts the server's rate limits and cooldown on each endpoint, where wait reasons read them.
     * One the answer leaves out is not cooling down. Telemetry only, so this sends nothing.
     */
    _installLive(live: Record<string, EndpointLive>): void {
      for (const ep of this.endpoints) {
        const seen = live[ep.id] ?? IDLE;
        ep.rateLimits = seen.rateLimits;
        ep.backoffUntil = seen.backoffUntil;
      }
    },
    /** Read the configuration once at start; `force` rereads it, as a refused write does. */
    async load(force = false): Promise<void> {
      if (this.loaded && !force) return;
      const before = edits;
      try {
        const answer = await this._service().getSettings();
        // something typed while the read was out is newer, and its write is already on its way
        if (this.loaded && edits !== before) return;
        // watched first: taking the watch over resets its bookkeeping
        this._writeBehind();
        this._install(answer);
        this.loaded = true;
      } catch (cause) {
        toastFailure("read the endpoints", cause);
      }
    },
    /**
     * Start watching for changes to send. The bookkeeping is module state, so another Pinia's
     * store detaches first, or it would keep sending that store's configuration.
     */
    _writeBehind(): void {
      if (watching?.deref() === this) return;
      this._detach();
      watching = new WeakRef(this);
      stopWatch = watch(
        () => JSON.stringify(this._config()),
        (now) => {
          edits++;
          // Back to what the server holds: nothing to send, unless a write out may change that.
          if (now === held && !sending) return cancelTimer();
          cancelTimer();
          timer = setTimeout(() => void this._save(), WRITE_DELAY_MS);
        },
      );
    },
    /** Stop the write-behind and forget its bookkeeping and samples: on takeover and in tests. */
    _detach(): void {
      stopWatch?.();
      stopWatch = null;
      watching = null;
      cancelTimer();
      edits = 0;
      sending = false;
      held = "";
      out = null;
      next = null;
      keysWaiting.clear();
      for (const { url } of samples.values()) URL.revokeObjectURL(url);
      samples.clear();
    },
    /**
     * Send what is waiting now and resolve once every edit so far is on the server, looping while
     * changes arrive during a write. Says how the last write it waited on went.
     */
    async flushWrites(): Promise<SaveOutcome> {
      let outcome: SaveOutcome = "landed";
      for (;;) {
        // the watch sees an edit before the next render
        await nextTick();
        const write = timer ? this._save() : (next ?? out);
        if (!write) return outcome;
        outcome = await write;
      }
    },
    /** Save now, or in the one write owed after the one out. Resolves with how that write went. */
    _save(): Promise<SaveOutcome> {
      cancelTimer();
      if (next) return next;
      if (out) {
        const after: Promise<SaveOutcome> = out.then(() => {
          // a store that has let the watch go sends nothing more
          if (next !== after) return "refused";
          next = null;
          return this._save();
        });
        return (next = after);
      }
      const write: Promise<SaveOutcome> = this._put().then((outcome) => {
        if (out === write) out = null;
        return outcome;
      });
      return (out = write);
    },
    /**
     * Send the configuration with any waiting keys; only `_save` calls it. Only the answer to the
     * latest change is installed, so a late answer never undoes typing. A refused write rereads
     * the server's configuration.
     */
    async _put(): Promise<SaveOutcome> {
      const n = edits;
      const body = this._config();
      // the keys go out but never come back
      const sent = JSON.stringify(body);
      const carried = [...keysWaiting.values()];
      keysWaiting.clear();
      for (const k of carried) {
        const entry = entriesOf(body, k.kind).find((e) => e.id === k.id);
        if (entry) entry.apiKey = k.apiKey;
      }
      // Lowered before installing: the watch would otherwise send the answer back.
      sending = true;
      let answer: EndpointSettings;
      try {
        answer = await this._service().putSettings(body);
      } catch (cause) {
        sending = false;
        // A refused key is always said; the rest only if nothing was typed past it.
        for (const k of carried) toastFailure(k.apiKey ? "save the key" : "remove the key", cause);
        if (edits !== n) return "refused";
        if (!carried.length) toastFailure("save the endpoints", cause);
        await this.load(true);
        return "refused";
      }
      sending = false;
      if (edits !== n) {
        // Typed past: the answer is stale, but `hasKey` is not something the page could change.
        for (const k of carried) {
          const kept = entriesOf(answer, k.kind).find((e) => e.id === k.id);
          const cur = entriesOf(this, k.kind).find((e) => e.id === k.id);
          if (cur && kept?.hasKey) cur.hasKey = true;
          else if (cur) delete cur.hasKey;
        }
        return "landed";
      }
      const same: EndpointConfig = {
        endpoints: answer.endpoints.map(storedOf),
        profiles: answer.profiles,
        transcribers: answer.transcribers,
        credentials: answer.credentials,
        prompt: answer.prompt ?? null,
        script: answer.script,
      };
      if (JSON.stringify(same) === sent) held = sent;
      else this._install(answer);
      return "landed";
    },
    /**
     * Give the server a key for one entry (`""` forgets it). False when there is no such entry or
     * it was refused. The key rides the next whole-configuration write beside the edited objects,
     * never on them, or it would go out with every write; only `hasKey` comes back.
     */
    async saveKey(kind: EndpointKind, id: string, apiKey: string): Promise<boolean> {
      if (!entriesOf(this, kind).some((e) => e.id === id)) return false;
      keysWaiting.set(`${kind}:${id}`, { kind, id, apiKey });
      return (await this._save()) === "landed";
    },
    /** Batch limits of the saved endpoint's server, null when it takes none. Flushes first. */
    async batchesOf(id: string): Promise<{ limits: BatchLimits | null } | { error: string }> {
      try {
        await this.flushWrites();
        return await this._service().batchLimits(id);
      } catch (cause) {
        const api = cause instanceof ApiError ? cause : null;
        if (api?.status === 404) return { error: "Not saved on the server yet" };
        return {
          error: api ? api.message : cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
    /**
     * Test the *saved* settings, not a connection draft: saving a draft can re-point queued work,
     * which the Save confirmation guards. Pending write-behind edits are flushed first. A test
     * that could not run is a failed result, not a throw.
     */
    async testSaved(kind: EndpointKind, id: string): Promise<ConnectionTest> {
      try {
        await this.flushWrites();
        const probe = await this._service().testEndpoint(kind, id);
        return {
          ok: probe.ok,
          at: Date.now(),
          ms: probe.ms,
          message: probe.message,
          detail: probe.ms
            ? `The server's request took ${probe.ms} ms, with the settings and key it has saved.`
            : "The server made no request to the provider.",
        };
      } catch (cause) {
        const api = cause instanceof ApiError ? cause : null;
        return {
          ok: false,
          at: Date.now(),
          ms: 0,
          message: api?.status === 404 ? "Not saved on the server yet" : "The test did not run",
          detail: api
            ? (api.detail ?? api.message)
            : cause instanceof Error
              ? cause.message
              : String(cause),
        };
      }
    },
    /** Null or the built-in prompt word for word is kept as built-in. False when not a whole prompt. */
    setLibraryPrompt(t: PromptTemplate | null): boolean {
      if (t && promptProblems(t).length) return false;
      this.prompt = keptPrompt(t);
      return true;
    },
    /**
     * Save a scripting endpoint's prompt. Notes are always checked; texts only while it replaces.
     * A Default endpoint with neither is kept as none. False when a check fails.
     */
    setProfilePrompt(id: string, prompt: ProfilePrompt): boolean {
      const p = this.profiles.find((x) => x.id === id);
      if (!p) return false;
      if (profilePromptProblems(prompt).length) return false;
      const { mode, system, user, notes } = prompt;
      p.prompt =
        mode === "default" && !system.trim() && !user.trim() && !notes.trim()
          ? null
          : { mode, system, user, notes };
      return true;
    },
    saveExpressionConfig(id: string, config: ExpressionConfig): boolean {
      const narrationStore = useNarrationStore();
      const uiStore = useUiStore();

      const ep = this.endpoints.find((e) => e.id === id);
      // checked against the endpoint's model and address now, not the draft's: allowed tags are
      // the provider's
      if (!ep || configErrors({ ...config, model: ep.model, baseUrl: ep.baseUrl }).length)
        return false;
      const previous = ep.expressions ? clone(ep.expressions) : undefined;
      ep.expressions = clone({
        ...config,
        model: ep.model,
        baseUrl: ep.baseUrl,
        tags: config.tags.map((t) => ({
          ...t,
          id: expressionId(t.label),
          label: t.label.trim(),
          token: t.token.trim(),
        })),
      });
      const restale = () => narrationStore.refreshExpressionAudio();
      restale();
      uiStore.toast("Expression support saved", {
        description: `Applies to ${ep.model}. Annotated lines are checked again before rendering.`,
        undo: () => {
          ep.expressions = previous;
          restale();
        },
      });
      return true;
    },
    // ---------- settings (every kind of endpoint, keys excluded) ----------
    exportSettings(): SettingsFile {
      const scriptingStore = useScriptingStore();

      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        endpoints: this.endpoints.map(
          ({
            history: _history,
            failures: _failures,
            rateLimits: _rateLimits,
            backoffUntil: _backoffUntil,
            lastError: _lastError,
            fetching: _fetching,
            ...e
          }) => portable(e),
        ),
        profiles: this.profiles.map(portable),
        transcribers: this.transcribers.map(portable),
        prompt: this.prompt ? { ...this.prompt } : null,
        scriptSettings: { ...scriptingStore.scriptSettings },
      };
    },
    importSettings(obj: Partial<SettingsFile> | null | undefined): void {
      const scriptingStore = useScriptingStore();
      const uiStore = useUiStore();

      if (!obj || !Array.isArray(obj.endpoints)) throw new Error("not a settings file");
      for (const ep of obj.endpoints) {
        // a file without brackets takes the ones the provider's docs show
        if (ep.expressions?.tags) ep.expressions = withBrackets(ep.expressions);
        if (ep.expressions && configErrors(ep.expressions).length)
          throw new Error(`Invalid expression support for ${ep.name}`);
      }
      if (obj.profiles != null && !Array.isArray(obj.profiles))
        throw new Error("Invalid scripting endpoints");
      if (obj.transcribers !== undefined && !Array.isArray(obj.transcribers))
        throw new Error("Invalid speech-to-text endpoints");
      if (obj.prompt !== undefined && !promptOk(obj.prompt))
        throw new Error("Invalid default prompt");
      // an older `append` prompt becomes notes (`newProfile` upgrades it)
      const profiles = (obj.profiles ?? []).map((imported) => {
        const existing = this.profiles.find((p) => p.id === imported?.id);
        // the file's `hasKey` belongs to another server, and a key would ride every write
        const profile = newProfile({ ...existing, ...portable(imported ?? {}) });
        if (profileErrors(profile).length)
          throw new Error("Invalid scripting endpoint: " + profile.name);
        return profile;
      });
      const transcribers = (obj.transcribers ?? []).map((imported) => {
        const existing = this.transcribers.find((t) => t.id === imported?.id);
        const transcriber = filled(
          { ...blankTranscriber(), ...existing, ...portable(imported ?? {}) },
          "transcription",
        );
        if (transcriberErrors(transcriber).length)
          throw new Error("Invalid speech-to-text endpoint: " + transcriber.name);
        return transcriber;
      });
      let n = 0;
      for (const e of obj.endpoints) {
        const cur = this.endpoints.find((x) => x.id === e.id);
        const fresh = {
          history: [],
          failures: 0,
          rateLimits: 0,
          backoffUntil: 0,
          ...portable(e),
        } as Endpoint;
        if (cur) filled(Object.assign(cur, fresh), "tts");
        else this.endpoints.push(filled(fresh, "tts"));
        n++;
      }
      for (const p of profiles) {
        const cur = this.profiles.find((x) => x.id === p.id);
        if (cur) filled(Object.assign(cur, p), "scripting");
        else this.profiles.push(filled(p, "scripting"));
      }
      for (const t of transcribers) {
        const cur = this.transcribers.find((x) => x.id === t.id);
        if (cur) Object.assign(cur, t);
        else this.transcribers.push(t);
      }
      if (obj.prompt !== undefined) this.prompt = keptPrompt(obj.prompt);
      if (obj.scriptSettings) {
        const { profile } = obj.scriptSettings;
        // the file's profile choice holds only if that profile is here
        if (this.profiles.some((p) => p.id === profile))
          scriptingStore.scriptSettings.profile = profile;
      }
      const said = `Imported ${n} narration and ${profiles.length} scripting endpoints`;
      uiStore.toast(
        transcribers.length ? `${said}, and ${transcribers.length} speech to text` : said,
        {
          kind: "success",
          description: "API keys are never in the file — add them again on each endpoint.",
          timeout: 7000,
        },
      );
    },
    /** Returns the new credential's id. */
    addCredential(label: string): string {
      const id = "cred-" + Math.random().toString(36).slice(2, 8);
      this.credentials.push({ id, label: label.trim() || "New credential", note: "" });
      return id;
    },
    addScriptProfile(): string {
      const p = filled(newProfile(), "scripting");
      this.profiles.push(p);
      return p.id;
    },
    removeScriptProfile(id: string): void {
      const jobsStore = useJobsStore();
      const scriptingStore = useScriptingStore();
      const uiStore = useUiStore();

      if (jobsStore.jobs.some((j) => !j.finishedAt && j.scriptRun?.profile.id === id)) {
        uiStore.toast("Cancel this endpoint's jobs before removing it", { kind: "warn" });
        return;
      }
      const i = this.profiles.findIndex((p) => p.id === id);
      if (i < 0) return;
      const [p] = this.profiles.splice(i, 1);
      // runs go to the first profile that can take one, until another is picked
      const chosen = scriptingStore.scriptSettings.profile === id;
      if (chosen) scriptingStore.scriptSettings.profile = null;
      uiStore.toast(`Removed ${p.name}`, {
        undo: () => {
          this.profiles.splice(i, 0, p);
          if (chosen) scriptingStore.scriptSettings.profile = id;
        },
      });
    },
    // ---------- transcription ----------
    /** `presetId` fills in what a provider pins down; every field stays editable. */
    addTranscriber(presetId?: string): Transcriber {
      const base = blankTranscriber();
      const preset = presetId ? transcriptionPresetById(presetId) : undefined;
      // a copy, so two endpoints never share the preset's pricing object
      this.transcribers.push(
        filled(Object.assign(base, preset ? clone(preset.apply) : undefined), "transcription"),
      );
      return this.transcribers[this.transcribers.length - 1];
    },
    removeTranscriber(id: string): void {
      const uiStore = useUiStore();

      const i = this.transcribers.findIndex((t) => t.id === id);
      if (i < 0) return;
      const [t] = this.transcribers.splice(i, 1);
      uiStore.toast(`Removed endpoint ${t.name}`, {
        undo: () => this.transcribers.splice(Math.min(i, this.transcribers.length), 0, t),
      });
    },
    /**
     * Hear a recording as words with the first transcriber on. Flushes first, so a transcriber
     * just switched on is known. Null on failure, which has been said.
     */
    async transcribe(file: File): Promise<string | null> {
      try {
        await this.flushWrites();
        return (await this._service().transcribe(file)).text;
      } catch (cause) {
        toastFailure("transcribe the sample", cause);
        return null;
      } finally {
        // a request may have reached the provider either way
        void invalidate({ key: keys.endpointRequests });
      }
    },
    // ---------- endpoints & their voices ----------
    /** `presetId` fills in what a provider pins down; every field stays editable. */
    addEndpoint(presetId?: string): Endpoint {
      const base: Endpoint = {
        id: "ep" + Date.now(),
        name: "New endpoint",
        baseUrl: "https://",
        model: "gpt-4o-mini-tts",
        concurrency: 1,
        enabled: false,
        latency: 1500,
        failRate: 0.03,
        price: 12,
        needsKey: true,
        maxChars: 0,
        splitAt: "sentence",
        voices: [],
        history: [],
        failures: 0,
        rateLimits: 0,
        backoffUntil: 0,
        fetching: false,
      };
      const preset = presetId ? presetById(presetId) : undefined;
      // a copy, so two endpoints never share the preset's billing object
      this.endpoints.push(
        filled(Object.assign(base, preset ? clone(preset.apply) : undefined), "tts"),
      );
      return this.endpoints[this.endpoints.length - 1];
    },
    removeEndpoint(id: string): void {
      const uiStore = useUiStore();

      // characters keep a dangling ref, shown as "missing" until undone or re-picked
      const i = this.endpoints.findIndex((e) => e.id === id);
      if (i < 0) return;
      const e = this.endpoints[i];
      this.endpoints.splice(i, 1);
      uiStore.toast(`Removed endpoint ${e.name}`, {
        undo: () => this.endpoints.splice(Math.min(i, this.endpoints.length), 0, e),
      });
    },
    addVoice(ep: Endpoint, { id, label, gender }: Partial<Voice>): boolean {
      id = (id ?? "").trim();
      if (!id || ep.voices.some((v) => v.id === id)) return false;
      ep.voices.push({ id, label: (label ?? "").trim() || id, gender: gender ?? "n" });
      return true;
    },
    /**
     * A voice's pace for every speaker on it who sets none; null or 1 = its own. Once saved, asks
     * about lines read at the old pace, in every book. False when refused.
     */
    async setVoiceSpeed(ep: Endpoint, voiceId: string, speed: number | null): Promise<boolean> {
      const v = ep.voices.find((x) => x.id === voiceId);
      if (!v) return false;
      const now = speed ?? 1;
      if ((v.speed ?? 1) === now) return true;
      if (now === 1) delete v.speed;
      else v.speed = now;
      if ((await this.flushWrites()) === "refused") return false;
      await useExistingLinesStore().askVoiceSpeed(
        voiceRef(ep.id, v.id),
        `${v.label} now reads at ${now}×`,
      );
      return true;
    },
    /** Remove a voice silently, as undoing its add does. */
    _dropVoice(endpointId: string, voiceId: string): void {
      const ep = this.endpoints.find((e) => e.id === endpointId);
      if (ep) ep.voices = ep.voices.filter((v) => v.id !== voiceId);
    },
    /** On a server that makes voices it is deleted there first, for good; false when refused. */
    async removeVoice(ep: Endpoint, id: string): Promise<boolean> {
      const uiStore = useUiStore();

      const i = ep.voices.findIndex((v) => v.id === id);
      if (i < 0) return false;
      const v = ep.voices[i];
      if (cloningOf(ep)?.deletes) {
        try {
          // the server reads the saved endpoint
          await this.flushWrites();
          await this._service().deleteVoice(ep.id, id);
        } catch (cause) {
          toastFailure(`delete ${v.label} on ${ep.name}`, cause);
          return false;
        }
        ep.voices = ep.voices.filter((x) => x.id !== id);
        uiStore.toast(`Deleted voice ${v.label} from ${ep.name}`, {
          description: "It is gone from the server too.",
        });
        return true;
      }
      ep.voices.splice(i, 1);
      uiStore.toast(`Removed voice ${v.label} from ${ep.name}`, {
        undo: () => ep.voices.splice(Math.min(i, ep.voices.length), 0, v),
      });
      return true;
    },
    // Voice discovery runs on the server (`POST /endpoints/voices`): most OpenAI-compatible servers
    // expose GET /audio/voices; Fish Audio has an authenticated per-account model catalogue, mapped
    // down to voice fields. Found voices are merged: new ids added, nothing touched or removed.
    fetchVoices(ep: Endpoint): Promise<number> {
      const uiStore = useUiStore();

      const fish = isFishAudio(ep);
      let empty = false;
      const work = (async () => {
        ep.fetching = true;
        try {
          // the server uses its saved key and base URL, so flush first
          await this.flushWrites();
          const found = await this._service().listVoices(ep.id, { source: "library" });
          empty = !found.voices.length;
          return this.mergeVoices(ep, found.voices);
        } finally {
          ep.fetching = false;
        }
      })();
      void uiStore.toastLoading(work, {
        loading: `Fetching voices from ${ep.name}\u2026`,
        success: (n) =>
          n
            ? `${n} voice${n === 1 ? "" : "s"} added to ${ep.name}`
            : empty && fish
              ? `${ep.name}: your library has no voices \u2014 search the public ones instead`
              : `${ep.name}: no new voices`,
        error: (e) =>
          e instanceof ApiError
            ? e.status === 404
              ? `${ep.name} is not saved on the server yet`
              : `${ep.name}: ${e.message}`
            : fish && String(e).includes("401")
              ? `${ep.name}: set the API key first \u2014 the voice library is per account`
              : `${ep.name}: voice list unavailable`,
      });
      return work.catch(() => 0);
    },
    /** Adds voices whose ids are new; returns how many. */
    mergeVoices(ep: Endpoint, found: Voice[]): number {
      const added = found
        .filter((v) => !ep.voices.some((x) => x.id === v.id))
        .map((v) => ({ ...v }));
      ep.voices.push(...added);
      return added.length;
    },
    /**
     * Hear a voice say `text`, else the default line (or the provider's recording): a real
     * (priced) request the server makes once and keeps. Replayed from this tab after. Null on
     * failure, which has been said.
     */
    async sampleVoice(ep: Endpoint, voiceId: string, text?: string): Promise<HeardSample | null> {
      const key = sampleKey(ep, voiceId, text);
      const heard = samples.get(key);
      if (heard) return heard;
      try {
        await this.flushWrites();
        const { blob, duration, source, unstretched } = await this._service().sampleVoice(
          ep.id,
          voiceId,
          text,
        );
        const sample = { url: URL.createObjectURL(blob), duration, source };
        // not kept, so the next press tries the speed again
        if (unstretched)
          useUiStore().toast("Played at 1×", {
            kind: "warning",
            description: "This voice's speed is made with Pedalboard, which needs uv.",
          });
        else samples.set(key, sample);
        return sample;
      } catch (cause) {
        toastFailure("play the sample", cause);
        return null;
      } finally {
        // a request may have reached the provider either way
        void invalidate({ key: keys.endpointRequests });
      }
    },
    /** The first recording `kept` was made from, to play; null on failure, which has been said. */
    async sourceRecording(ep: Endpoint, kept: KeptVoiceSamples): Promise<string | null> {
      const [first] = kept.samples;
      if (!first) return null;
      const key = JSON.stringify([ep.id, kept.voiceId, first.file]);
      const known = sources.get(key);
      if (known) return known;
      try {
        const url = URL.createObjectURL(
          await this._service().keptSampleFile(ep.id, kept.voiceId, first.file),
        );
        sources.set(key, url);
        return url;
      } catch (cause) {
        toastFailure("play the recording", cause);
        return null;
      }
    },
    /**
     * Clone a voice on `ep`'s provider and add it; the write-behind saves it. If the server could
     * not keep the samples the voice is still made. Null when refused, which has been said.
     */
    async cloneVoice(ep: Endpoint, request: VoiceCloneRequest): Promise<Voice | null> {
      const uiStore = useUiStore();
      try {
        await this.flushWrites();
        const { samplesKept, warning, ...voice } = await this._service().cloneVoice(ep.id, request);
        this.addVoice(ep, voice);
        // the provider's "wait before speaking" note comes first: speaking sooner fails
        const said = samplesKept
          ? "It is private to your account, and on this endpoint's list now. Its samples are kept here with it."
          : "It is private to your account, and on this endpoint's list now — but its samples could not be kept here. Keep them from the voice's row to let it travel with a script.";
        uiStore.toast(`Made the voice ${voice.label} on ${ep.name}`, {
          kind: samplesKept && !warning ? "success" : "warn",
          description: warning ? `${warning} ${said}` : said,
        });
        return voice;
      } catch (cause) {
        toastFailure("make the voice", cause);
        return null;
      }
    },
    /** Voices of `ep` with kept samples. Empty when unsaved or the server could not say. */
    async keptSamples(ep: Endpoint): Promise<KeptVoiceSamples[]> {
      try {
        return await this._service().keptSamples(ep.id);
      } catch {
        return [];
      }
    },
    /**
     * Keep samples for a voice already on `ep`, replacing any; nothing goes to the provider.
     * Saves first, so the server knows the voice. Null when refused, which has been said.
     */
    async keepVoiceSamples(
      ep: Endpoint,
      voiceId: string,
      request: Omit<VoiceCloneRequest, "title">,
    ): Promise<KeptVoiceSamples | null> {
      const uiStore = useUiStore();
      try {
        await this.flushWrites();
        const kept = await this._service().keepSamples(ep.id, voiceId, request);
        uiStore.toast(
          `Kept ${kept.samples.length} sample${kept.samples.length === 1 ? "" : "s"} of ${kept.title}`,
          {
            kind: "success",
            description: "They stay on this server with the voice, and go if the voice is removed.",
          },
        );
        return kept;
      } catch (cause) {
        toastFailure("keep the samples", cause);
        return null;
      }
    },
    /**
     * One page of Fish Audio's public voice search. Results are only shown; `addVoice` adds one.
     * Throws the server's `ApiError`. Not cached.
     */
    async searchVoices(
      ep: Endpoint,
      query: Omit<VoiceListQuery, "source">,
    ): Promise<VoiceListPage> {
      await this.flushWrites();
      return this._service().listVoices(ep.id, { ...query, source: "public" });
    },
    // how many segments of this book a limit would split, for the endpoint card
    splitCount(bookId: string, ep: Endpoint): number {
      const castStore = useCastStore();
      const scriptsStore = useScriptsStore();

      if (!ep.maxChars) return 0;
      let n = 0;
      for (const k of Object.keys(scriptsStore.segments))
        if (k.startsWith(bookId + ":"))
          for (const s of scriptsStore.segments[k])
            if (
              castStore.effectiveVoice(bookId, s.speaker).endpoint?.id === ep.id &&
              s.text.length > ep.maxChars
            )
              n++;
      return n;
    },
  },
});
