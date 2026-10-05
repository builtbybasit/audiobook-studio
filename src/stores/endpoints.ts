// Provider configurations and voice catalogues. The server keeps each endpoint's key and this
// store only ever holds whether it does (`hasKey`) — a typed key goes out in one write (`saveKey`)
// and is never kept.
//
// The configuration is the server's: a narration job there reads it to know which endpoint a line
// goes to and at what sample rate. The page binds its fields straight onto these objects — a text
// box writes `ep.concurrency`, a toggle `ep.enabled`, an import assigns a dozen fields at once — so
// rather than chase every one of those into a request, the store *writes behind*: it watches the
// configuration as one document (the endpoints without their telemetry, the profiles, the
// transcribers, the credential registry), and a short while after it last changed sends the whole
// of it. What the
// server answers is what the store then holds.
//
// The scripting settings travel in it too (`script`, the scripting store's `scriptSettings`), and
// are written behind like the rest. The library's default scripting prompt travels in the same
// document (`prompt`, null for the built-in one), but it is not bound onto anything: the page
// stages an edit to it and saves it on purpose (`setLibraryPrompt`), as it does an endpoint's own
// prompt (`setProfilePrompt`), since a prompt half-typed is one the server would refuse and every
// run would read.
//
// The request history, failure counts and back-off on each endpoint are not configuration. The
// server never stores them, and neither sending nor installing a configuration touches them. The
// rate limits and the cooldown are the server's gate's (`_installLive`), read while narration is
// running, and the lines each endpoint has out and held sit beside the endpoints in `live` rather
// than on them. They are left out of what the write-behind watches, so a poll never sends a save.
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
import { configErrors, expressionId } from "@/lib/expressions";
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
import { useJobsStore } from "@/stores/jobs";
import { useNarrationStore } from "@/stores/narration";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { toastFailure } from "@/stores/toastFailure";
import { useUiStore } from "@/stores/ui";
interface EndpointsState {
  endpoints: Endpoint[];
  profiles: Profile[];
  /** The speech-to-text endpoints: what hears a clone sample back as words. */
  transcribers: Transcriber[];
  /** The library's default scripting prompt, as saved; null is the built-in one. */
  prompt: PromptTemplate | null;
  /** The named credentials the endpoints and profiles say they use; names only, never a key. */
  credentials: Credential[];
  /** Whether the configuration has been read from the server yet. */
  loaded: boolean;
}

/** An endpoint the server has sent nothing to: nothing out, nothing held. */
const IDLE: EndpointLive = { active: 0, waiting: 0, rateLimits: 0, backoffUntil: 0 };
/** No endpoint's telemetry, before the first read. */
const NONE: Record<string, EndpointLive> = {};

/** How long the configuration has to sit still before it is sent. A number box sends nothing
 *  per keystroke; a pause sends the value typed. */
export const WRITE_DELAY_MS = 400;

const telemetry = new Set<string>(ENDPOINT_TELEMETRY);

/** An endpoint's configuration, leaving its telemetry behind. */
function storedOf(ep: Endpoint): StoredEndpoint {
  // Key by key rather than a rest spread: a spread reads every field, and the write-behind watch
  // would then run again on every request an endpoint records, only to find nothing to send.
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
    // `apiKey` is never on these objects, and is dropped anyway: a key that got onto one would
    // otherwise go out with every write-behind, and a stale `""` there would forget the key
    profiles: profiles.map(({ apiKey: _apiKey, ...p }) => p),
    // always sent, though the server would keep what it holds without them: what the page shows is
    // what the server should hold
    transcribers: transcribers.map(({ apiKey: _apiKey, ...t }) => t),
    credentials: credentials.map((c) => ({ ...c })),
    // always sent, so what the server holds is what the page shows
    prompt,
    // the choice of profile only ever names one saved with it, which the server insists on
    script: {
      ...script,
      profile: profiles.some((p) => p.id === script.profile) ? script.profile : null,
    },
  };
}

/** Where each kind's list is, in the store, a write's body and the server's answer alike. */
const LIST: Record<EndpointKind, "profiles" | "endpoints" | "transcribers"> = {
  scripting: "profiles",
  tts: "endpoints",
  transcription: "transcribers",
};

/** One kind's entries in any of the three, as the fields a key write touches. */
const entriesOf = (
  doc: Pick<EndpointConfig, "profiles" | "endpoints" | "transcribers">,
  kind: EndpointKind,
): { id: string; apiKey?: string; hasKey?: boolean }[] => doc[LIST[kind]];

/**
 * An entry of any kind with its operational settings and its pricing block filled in, for one
 * saved before either existed. Every one the store takes on comes through here — read from the
 * server, added, or imported from a file — so the pages that edit them never find a field missing.
 * Filling in the defaults is idempotent and changes nothing a request would do differently: an
 * empty schedule and no promotions is exactly ordinary pricing.
 */
function filled<T extends Endpoint | Profile | Transcriber>(ep: T, kind: EndpointKind): T {
  ensureOps(ep, kind);
  ensurePricing(ep);
  return ep;
}

/** A template as it is kept: null when it is the built-in prompt, word for word. */
function keptPrompt(t: PromptTemplate | null): PromptTemplate | null {
  return !t || (t.system === BUILT_IN_PROMPT.system && t.user === BUILT_IN_PROMPT.user)
    ? null
    : { system: t.system, user: t.user };
}

/** Whether a settings file's default prompt is one: null, or two strings that make a whole prompt. */
function promptOk(t: unknown): t is PromptTemplate | null {
  if (t === null) return true;
  const o = t as Partial<PromptTemplate> | undefined;
  return (
    typeof o?.system === "string" &&
    typeof o.user === "string" &&
    !promptProblems({ system: o.system, user: o.user }).length
  );
}

/** What a settings file keeps of an entry: neither the key nor whether some server holds one. */
function portable<T extends { apiKey?: string; hasKey?: boolean }>(e: T): T {
  const { apiKey: _apiKey, hasKey: _hasKey, ...rest } = e;
  return rest as T;
}

/**
 * Take on what the server holds for one object, keeping the object: the page holds references to
 * the endpoint it has open, and a replaced object would leave it editing one the store has let go.
 * A field the server did not send is gone; telemetry is never the server's to change.
 */
function adopt<T extends object>(cur: T, next: T): T {
  const target = cur as Record<string, unknown>;
  const source = next as Record<string, unknown>;
  for (const k of Object.keys(target)) if (!telemetry.has(k) && !(k in source)) delete target[k];
  for (const k of Object.keys(source)) if (!telemetry.has(k)) target[k] = source[k];
  return cur;
}

// The write-behind's bookkeeping. Not state: nothing renders it, and a reload starting it again
// from nothing is correct.
/** Local changes seen so far. A write's answer is installed only if none came after it. */
let edits = 0;
/** Writes sent and not yet answered. */
let inFlight = 0;
/** The configuration as the server last described it, serialized: what is not a change. */
let held = "";
let timer: ReturnType<typeof setTimeout> | null = null;
let stopWatch: (() => void) | null = null;
/**
 * The store the watch is on, held weakly: a page has one, and a second Pinia's (a test's next tab)
 * takes it over.
 */
let watching: WeakRef<object> | null = null;
/** Writes sent and not yet answered, for `flushWrites` to wait on. */
const writing = new Set<Promise<unknown>>();

/** Count `write` among those out until it settles, however it settles. */
function tracked<T>(write: Promise<T>): Promise<T> {
  writing.add(write);
  const done = () => void writing.delete(write);
  write.then(done, done);
  return write;
}

/** A voice heard, as an object url; `duration` is null when only the file knows it. */
export interface HeardSample {
  url: string;
  duration: number | null;
  source: "recording" | "rendered";
}

/**
 * Voice samples heard this session, as object urls, by what they were rendered with. The server
 * keeps them too, so this only saves the round trip — until the endpoint is pointed at another
 * server, model, format or rate, which would make it a different sample.
 */
const samples = new Map<string, HeardSample>();
const sampleKey = (ep: Endpoint, voiceId: string): string =>
  JSON.stringify([ep.id, ep.baseUrl, ep.model, encodingOf(ep), ep.sampleRate ?? null, voiceId]);

/** A transcriber with nothing filled in: off, and priced as free until a rate is set. */
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
  // The configuration is only ever the server's: the store starts on none and `load` installs what
  // the server holds. A server nobody has configured has no endpoints.
  state: (): EndpointsState => ({
    endpoints: [],
    profiles: [],
    transcribers: [],
    prompt: null,
    credentials: [],
    loaded: false,
  }),
  getters: {
    /**
     * What the server's process last said of each speech endpoint it has sent to, by id
     * (`GET /api/endpoints/live`, read by `useEndpointLive`). Empty until narration first runs.
     */
    live(): Record<string, EndpointLive> {
      return useQueryCache().getQueryData<Record<string, EndpointLive>>(keys.endpointLive) ?? NONE;
    },
    /**
     * Lines out at a speech endpoint and lines held for it, across every job, as the server counts
     * them. The clips the browser has loaded are only those of the chapters it has opened; the gate
     * counts every job's lines.
     */
    serverLoad(): (id: string) => EndpointLive {
      return (id) => this.live[id] ?? IDLE;
    },
    enabledEndpoints(s): Endpoint[] {
      return s.endpoints.filter((e) => e.enabled);
    },
    /** Whether a recording can be heard back as words: some transcriber is switched on. */
    canTranscribe(s): boolean {
      return s.transcribers.some((t) => t.enabled);
    },
    resolveVoice(s): (ref: string | null | undefined) => ResolvedVoice | null {
      return (ref: VoiceRef | null | undefined): ResolvedVoice | null => {
        if (!ref) return null;
        const i = ref.indexOf("/");
        const ep = s.endpoints.find((e) => e.id === ref.slice(0, i));
        const v = ep?.voices.find((v) => v.id === ref.slice(i + 1));
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
    /**
     * Hold the configuration the server answered with, in place of this one.
     *
     * An endpoint that survives keeps its object and its telemetry; a new one starts with none.
     */
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
      // What the watch will see next is the answer, and the answer is not a change to send.
      held = JSON.stringify(this._config());
    },
    /**
     * Put what the server's process last said of each speech endpoint's rate limits and cooldown on
     * the endpoint, where the wait reasons and the effective limit read them. An endpoint the answer
     * leaves out has had nothing sent to it, so it is not cooling down. Both fields are telemetry,
     * which the write-behind never sees, so this sends nothing. The counts themselves stay in the
     * query cache, where `live` reads them.
     */
    _installLive(live: Record<string, EndpointLive>): void {
      for (const ep of this.endpoints) {
        const seen = live[ep.id] ?? IDLE;
        ep.rateLimits = seen.rateLimits;
        ep.backoffUntil = seen.backoffUntil;
      }
    },
    /**
     * Read the configuration from the server.
     *
     * Called once when the app starts; `force` reads it again, which is what a refused write does
     * to put back what the server actually holds. A server that has never been given a
     * configuration answers with none, and none is what the page then shows.
     */
    async load(force = false): Promise<void> {
      if (this.loaded && !force) return;
      const before = edits;
      try {
        const answer = await this._service().getSettings();
        // Something was typed while the read was out: that is newer than what it read, and its
        // own write is already on its way.
        if (this.loaded && edits !== before) return;
        // watched first: taking the watch over from another store starts its bookkeeping afresh,
        // and what is installed next is what the server holds
        this._writeBehind();
        this._install(answer);
        this.loaded = true;
      } catch (cause) {
        toastFailure("read the endpoints", cause);
      }
    },
    /**
     * Start watching the configuration for changes to send. Once per store: the bookkeeping is
     * module state, so a store that is not the one being watched — another Pinia's — lets the
     * other's watch and bookkeeping go first, or it would keep sending that store's configuration.
     */
    _writeBehind(): void {
      if (watching?.deref() === this) return;
      this._detach();
      watching = new WeakRef(this);
      stopWatch = watch(
        () => JSON.stringify(this._config()),
        (now) => {
          edits++;
          // Back to what the server holds, with nothing on its way that says otherwise: there is
          // nothing to send. With a write out, the server may be about to hold something else,
          // so this has to be said too.
          if (now === held && !inFlight) return cancelTimer();
          cancelTimer();
          timer = setTimeout(() => void this._send(), WRITE_DELAY_MS);
        },
      );
    },
    /** Stop the write-behind and forget its bookkeeping, and the samples heard: before another
     *  store takes the watch over, and in a test between one store and the next. */
    _detach(): void {
      stopWatch?.();
      stopWatch = null;
      watching = null;
      writing.clear();
      cancelTimer();
      edits = 0;
      inFlight = 0;
      held = "";
      for (const { url } of samples.values()) URL.revokeObjectURL(url);
      samples.clear();
    },
    /**
     * Send what is waiting now rather than when the timer would have, and resolve once everything
     * edited so far is on the server: a write already out is waited for, and so is the one sent
     * for what was typed while it was out. A no-op when nothing is waiting or out.
     *
     * A change made while a write was out sets the timer again, so this goes round until nothing
     * is waiting and nothing is out.
     */
    async flushWrites(): Promise<void> {
      for (;;) {
        // the watch sees an edit only before the next render, so a caller that has just edited
        // needs nothing of its own
        await nextTick();
        if (timer) await this._send();
        else if (writing.size) await Promise.allSettled(writing);
        else return;
      }
    },
    /**
     * Send the configuration as it stands, taking it off the timer.
     *
     * Only the answer to the latest change is installed: an earlier write answering after the
     * person has typed past it would put back what they typed over. A refused write is said, and
     * the server's configuration is read back so the page shows what is actually in force.
     */
    async _send(): Promise<void> {
      cancelTimer();
      const n = edits;
      const body = this._config();
      const sent = JSON.stringify(body);
      // The count comes down before anything is installed: the watch sees an installed answer
      // after this returns, and while a write is counted as out it would send that answer back.
      inFlight++;
      let answer: EndpointSettings;
      try {
        answer = await tracked(this._service().putSettings(body));
      } catch (cause) {
        inFlight--;
        if (edits !== n) return;
        toastFailure("save the endpoints", cause);
        await this.load(true);
        return;
      }
      inFlight--;
      if (edits !== n) return;
      // The usual case: the server holds exactly what was sent, so there is nothing to put back on
      // the objects the page is editing.
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
    },
    /**
     * Give the server a key for one entry of any kind (`""` forgets it). Resolves true once the
     * server has answered.
     *
     * The key rides on the whole-configuration write, on that one entry only, and never touches
     * the objects the page edits: the write-behind sends those again and again, and an `apiKey`
     * left on one would go out with every write after it. So this writes now rather than behind —
     * with whatever else is waiting, which it therefore takes off the timer — and what comes back
     * is `hasKey`, which is all the page is ever told.
     */
    async saveKey(kind: EndpointKind, id: string, apiKey: string): Promise<boolean> {
      const body = this._config();
      const entry = entriesOf(body, kind).find((e) => e.id === id);
      if (!entry) return false;
      entry.apiKey = apiKey;
      cancelTimer();
      const n = edits;
      inFlight++;
      let answer: EndpointSettings;
      try {
        answer = await tracked(this._service().putSettings(body));
      } catch (cause) {
        inFlight--;
        toastFailure(apiKey ? "save the key" : "remove the key", cause);
        if (edits === n) await this.load(true);
        return false;
      }
      inFlight--;
      if (edits === n) this._install(answer);
      else {
        // Typed past while the key was out: the rest of the answer is older than the page, but
        // whether a key is held is not something the page could have changed in the meantime.
        const held = entriesOf(answer, kind).find((e) => e.id === id);
        const cur = entriesOf(this, kind).find((e) => e.id === id);
        if (cur && held?.hasKey) cur.hasKey = true;
        else if (cur) delete cur.hasKey;
      }
      return true;
    },
    /**
     * Whether the saved speech endpoint's server takes batches, for the Requests tab: its limits,
     * null when it takes none, or why it could not be asked. What the write-behind holds is sent
     * first, as for a test.
     */
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
     * Ask the server to test what it holds for this endpoint, as the Connection tab's result.
     *
     * It tests the *saved* settings, not a connection draft: saving a draft can re-point queued
     * work at another provider, which is what the Save button's confirmation is there for, and a
     * test that saved on the way would step round it. What the write-behind is still holding is
     * sent first, though — the page shows those edits as already in force. A test that could not
     * run is a failed result rather than a throw, so the tab shows it where it shows the others.
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
    /**
     * Save the library's default prompt; null, or the built-in prompt word for word, is kept as
     * the built-in one. False, and nothing saved, when it is not a whole prompt. The write-behind
     * sends it.
     */
    setLibraryPrompt(t: PromptTemplate | null): boolean {
      if (t && promptProblems(t).length) return false;
      this.prompt = keptPrompt(t);
      return true;
    },
    /**
     * Save one scripting endpoint's say over the prompt. Its notes are always checked, and its
     * texts as a whole prompt only while it replaces — the text a Default endpoint keeps is not
     * sent — and a Default endpoint with neither text nor notes is kept as none. False, and nothing
     * saved, when something checked has a problem.
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
      // checked as it is about to be saved — for the endpoint's model and address now, not those
      // the draft was opened with: which tags are allowed is the provider's, and the model may have
      // changed on the Connection tab since
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
      for (const ep of obj.endpoints)
        if (ep.expressions && configErrors(ep.expressions).length)
          throw new Error(`Invalid expression support for ${ep.name}`);
      if (obj.profiles != null && !Array.isArray(obj.profiles))
        throw new Error("Invalid scripting endpoints");
      // a file from before transcription endpoints says nothing of them, and leaves these be
      if (obj.transcribers !== undefined && !Array.isArray(obj.transcribers))
        throw new Error("Invalid speech-to-text endpoints");
      // a file from before the prompt could be edited says nothing of it, and leaves this one's be
      if (obj.prompt !== undefined && !promptOk(obj.prompt))
        throw new Error("Invalid default prompt");
      // an endpoint's `append` prompt, from a file written before notes, comes in as its notes
      // (`newProfile` upgrades it)
      const profiles = (obj.profiles ?? []).map((imported) => {
        const existing = this.profiles.find((p) => p.id === imported?.id);
        // what the file says about a key is dropped: `hasKey` belongs to the server that wrote it,
        // and a key in the file would ride along on every write from here on
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
        // a file's choice of profile holds only if that profile is here now
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
    /** A new named credential for the Connection tab to pick. Returns its id. */
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
      // runs no longer go to it: the first profile that can take one does, until another is picked
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
    /** `presetId` fills in what a provider pins down (base URL, model, rate); every field stays
     *  editable afterwards. Without one this is a blank OpenAI-shaped endpoint. */
    addTranscriber(presetId?: string): Transcriber {
      const base = blankTranscriber();
      const preset = presetId ? transcriptionPresetById(presetId) : undefined;
      // a copy, so the preset's pricing never becomes an object two endpoints share
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
     * What is said in one recording, heard by the first transcriber switched on: the clone form's
     * Transcribe button. What the write-behind holds is sent first, so a transcriber just switched
     * on is one the server knows. Null when it could not be heard, which has been said.
     */
    async transcribe(file: File): Promise<string | null> {
      try {
        await this.flushWrites();
        return (await this._service().transcribe(file)).text;
      } catch (cause) {
        toastFailure("transcribe the sample", cause);
        return null;
      } finally {
        // answered or not, a request may have reached the provider, and it is a row on this page
        void invalidate({ key: keys.endpointRequests });
      }
    },
    // ---------- endpoints & their voices ----------
    /** `presetId` fills in what a provider pins down (base URL, model, billing, limits); every
     *  field stays editable afterwards. Without one this is the blank OpenAI-shaped endpoint. */
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
      // a copy, so the preset's billing never becomes an object two endpoints share
      this.endpoints.push(
        filled(Object.assign(base, preset ? clone(preset.apply) : undefined), "tts"),
      );
      return this.endpoints[this.endpoints.length - 1];
    },
    removeEndpoint(id: string): void {
      const uiStore = useUiStore();

      // characters keep a dangling ref → shown as "missing" until undone or re-picked
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
    /** Take a voice off an endpoint without a word, as an undo of adding it does. */
    _dropVoice(endpointId: string, voiceId: string): void {
      const ep = this.endpoints.find((e) => e.id === endpointId);
      if (ep) ep.voices = ep.voices.filter((v) => v.id !== voiceId);
    },
    removeVoice(ep: Endpoint, id: string): void {
      const uiStore = useUiStore();

      const i = ep.voices.findIndex((v) => v.id === id);
      if (i < 0) return;
      const v = ep.voices[i];
      ep.voices.splice(i, 1);
      uiStore.toast(`Removed voice ${v.label} from ${ep.name}`, {
        undo: () => ep.voices.splice(Math.min(i, ep.voices.length), 0, v),
      });
    },
    // Voice discovery. Most OpenAI-compatible servers (Kokoro-FastAPI, Orpheus…) expose
    // GET /audio/voices; Fish Audio instead has a per-account model catalogue at the host root,
    // which is authenticated and returns far more than voices, so it is mapped down to the few
    // fields a voice picker needs. The server asks the real endpoint (`POST /endpoints/voices`), and
    // what it finds is merged: new ids are added, and nothing already here is touched or removed.
    fetchVoices(ep: Endpoint): Promise<number> {
      const uiStore = useUiStore();

      const fish = isFishAudio(ep);
      let empty = false;
      const work = (async () => {
        ep.fetching = true;
        try {
          // The server asks what it has saved, key and base URL alike, so what the page is still
          // holding goes first.
          await this.flushWrites();
          const found = await this._service().listVoices(ep.id, { source: "library" });
          empty = !found.voices.length;
          return this.mergeVoices(ep, found.voices);
        } finally {
          ep.fetching = false;
        }
      })();
      uiStore.toastLoading(work, {
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
    /** Add the voices whose ids this endpoint does not have yet; answers how many that was. */
    mergeVoices(ep: Endpoint, found: Voice[]): number {
      const added = found
        .filter((v) => !ep.voices.some((x) => x.id === v.id))
        .map((v) => ({ ...v }));
      ep.voices.push(...added);
      return added.length;
    },
    /**
     * One of `ep`'s voices, heard: the provider's own recording of it, or the saved endpoint saying
     * the sample sentence with its saved key — a real request, priced into the ledger, that the
     * server makes once and keeps. Heard once in this tab, it is replayed from here. Null when the
     * request failed, which has been said.
     */
    async sampleVoice(ep: Endpoint, voiceId: string): Promise<HeardSample | null> {
      const key = sampleKey(ep, voiceId);
      const heard = samples.get(key);
      if (heard) return heard;
      try {
        await this.flushWrites();
        const { blob, duration, source } = await this._service().sampleVoice(ep.id, voiceId);
        const sample = { url: URL.createObjectURL(blob), duration, source };
        samples.set(key, sample);
        return sample;
      } catch (cause) {
        toastFailure("play the sample", cause);
        return null;
      } finally {
        // answered or not, a request may have reached the provider, and it is a row on this page
        void invalidate({ key: keys.endpointRequests });
      }
    },
    /**
     * Make a voice from samples on `ep`'s provider and add it to the endpoint, where the
     * write-behind saves it like any other voice. The server keeps the samples with it; when it
     * could not, the voice is still made, and the toast says the samples were not kept. Null
     * when the provider refused, which has been said.
     */
    async cloneVoice(ep: Endpoint, request: VoiceCloneRequest): Promise<Voice | null> {
      const uiStore = useUiStore();
      try {
        await this.flushWrites();
        const { samplesKept, warning, ...voice } = await this._service().cloneVoice(ep.id, request);
        this.addVoice(ep, voice);
        // what the provider said to do before the voice speaks comes first: a line spoken with it
        // before then fails
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
    /**
     * Every voice of `ep` whose samples the server keeps. Empty when the endpoint is not saved
     * yet, or the server could not say — the Voices tab then offers nothing it cannot do.
     */
    async keptSamples(ep: Endpoint): Promise<KeptVoiceSamples[]> {
      try {
        return await this._service().keptSamples(ep.id);
      } catch {
        return [];
      }
    },
    /**
     * Keep the samples a voice already on `ep` was made from, in place of any it had. Nothing is
     * sent to the provider. The endpoint is saved first, so a voice added on the page is one the
     * server knows. Null when the server refused, which has been said.
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
     * Forget the samples kept for one voice of `ep`; the voice stays. The server only hides them
     * until a later save makes it final, so the toast's Undo brings them back, and `restored` hands
     * them to whoever shows them. False when the forget failed.
     */
    async forgetVoiceSamples(
      ep: Endpoint,
      kept: KeptVoiceSamples,
      restored: (k: KeptVoiceSamples) => void,
    ): Promise<boolean> {
      const svc = this._service();
      const uiStore = useUiStore();
      try {
        await svc.forgetSamples(ep.id, kept.voiceId);
      } catch (cause) {
        toastFailure("forget the samples", cause);
        return false;
      }
      uiStore.toast(`Forgot the samples of ${kept.title}`, {
        description: "The voice stays. The samples go from this server for good after a day.",
        undo: () =>
          void svc
            .restoreSamples(ep.id, kept.voiceId)
            .then(restored, (cause) => toastFailure("bring the samples back", cause)),
      });
      return true;
    },
    /**
     * One page of a public voice search on the server — Fish Audio's catalogue. The answer is only
     * shown: a voice joins the endpoint when the page adds it (`addVoice`), and the write-behind
     * saves it. Throws the server's `ApiError`, which the search panel shows where it searched.
     * Nothing is cached: a search is typed, read and moved past.
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
