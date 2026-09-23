// Provider configurations and voice catalogues. In the demo, credentials remain in the keyring;
// with a server answering, the server keeps each endpoint's key and this store only ever holds
// whether it does (`hasKey`) — a typed key goes out in one write (`saveKey`) and is never kept.
//
// With a server answering, the configuration is the server's: a narration job there reads it to
// know which endpoint a line goes to and at what sample rate. The page binds its fields straight
// onto these objects — a text box writes `ep.concurrency`, a toggle `ep.enabled`, an import
// assigns a dozen fields at once — so rather than chase every one of those into a request, the
// store *writes behind*: it watches the configuration as one document (the endpoints without their
// telemetry, the profiles, the credential registry), and a short while after it last changed sends
// the whole of it. What the server answers is what the store then holds. Demo mode has no server
// and none of this runs; the seeded configuration is simply what the page edits.
//
// The request history, failure counts and back-off on each endpoint are not configuration. They
// are this browser's record of what it sent, the server never stores them, and neither sending nor
// installing a configuration touches them.
import { watch } from "vue";
import { credentials } from "@/lib/credentials";
import { isFishAudio, presetById } from "@/lib/endpoints";
import { configErrors, expressionId } from "@/lib/expressions";
import { keyring } from "@/lib/keyring";
import { newProfile, profileErrors } from "@/lib/scripting";
import { GENDER } from "@/lib/scriptReview";
import { clone } from "@/lib/utils";
import { discoverVoices, voiceRef } from "@/mock";
import {
  activeEndpointSettingsService,
  ENDPOINT_TELEMETRY,
  type EndpointConfig,
  type EndpointSettings,
  type EndpointSettingsService,
  type StoredEndpoint,
} from "@/services/endpointSettings";
import { ApiError } from "@/services/http";
import type {
  ConnectionTest,
  Endpoint,
  EndpointKind,
  ExpressionConfig,
  Profile,
  ResolvedVoice,
  SettingsFile,
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
import { seedState } from "@/stores/seed";
import { useUiStore } from "@/stores/ui";
interface EndpointsState {
  endpoints: Endpoint[];
  profiles: Profile[];
  /** Backend mode: whether the configuration has been read from the server yet. */
  loaded: boolean;
}

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

function configOf(endpoints: Endpoint[], profiles: Profile[]): EndpointConfig {
  return {
    endpoints: endpoints.map(storedOf),
    // `apiKey` is never on these objects, and is dropped anyway: a key that got onto one would
    // otherwise go out with every write-behind, and a stale `""` there would forget the key
    profiles: profiles.map(({ apiKey: _apiKey, ...p }) => p),
    credentials: credentials.map((c) => ({ ...c })),
  };
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

function cancelTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

export const useEndpointsStore = defineStore("endpoints", {
  // Backend mode starts from the seeded configuration too, but only for as long as it takes to
  // read the server's: `load` replaces it, and a server that has never been given one is given
  // this one — which is how a first run adopts the demo's endpoints rather than starting on none.
  state: (): EndpointsState => ({ ...seedState("endpoints", "profiles"), loaded: false }),
  getters: {
    enabledEndpoints(s): Endpoint[] {
      return s.endpoints.filter((e) => e.enabled);
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
    _service(): EndpointSettingsService | null {
      return activeEndpointSettingsService();
    },
    /** Say a request failed. The caller decides what to read again. */
    _failed(what: string, cause: unknown): void {
      const uiStore = useUiStore();
      const api = cause instanceof ApiError ? cause : null;
      uiStore.toast(api ? api.message : `Could not ${what}`, {
        kind: "error",
        description: api?.detail ?? (cause instanceof Error ? cause.message : undefined),
        timeout: 8000,
      });
    },
    _config(): EndpointConfig {
      return configOf(this.endpoints, this.profiles);
    },
    /**
     * Hold the configuration the server answered with, in place of this one.
     *
     * An endpoint that survives keeps its object and its telemetry; a new one starts with none.
     * The credential registry is a module-level list the Connection tab reads directly, so it is
     * refilled in place rather than replaced.
     */
    _install(answer: EndpointSettings): void {
      const endpoints = new Map(this.endpoints.map((e) => [e.id, e]));
      this.endpoints = answer.endpoints.map((e) => {
        const cur = endpoints.get(e.id);
        return cur
          ? adopt(cur, e)
          : { ...e, history: [], failures: 0, rateLimits: 0, backoffUntil: 0 };
      });
      const profiles = new Map(this.profiles.map((p) => [p.id, p]));
      this.profiles = answer.profiles.map((p) => {
        const cur = profiles.get(p.id);
        return cur ? adopt(cur, p) : p;
      });
      credentials.splice(0, credentials.length, ...answer.credentials);
      // What the watch will see next is the answer, and the answer is not a change to send.
      held = JSON.stringify(this._config());
    },
    /**
     * Read the configuration from the server. Demo mode is already holding one.
     *
     * Called once when the app starts in backend mode; `force` reads it again, which is what a
     * refused write does to put back what the server actually holds. A server that has never been
     * given a configuration is given the one this store started with.
     */
    async load(force = false): Promise<void> {
      const svc = this._service();
      if (!svc || (this.loaded && !force)) return;
      const before = edits;
      try {
        let answer = await svc.getSettings();
        if (!answer.saved) answer = await svc.putSettings(this._config());
        // Something was typed while the read was out: that is newer than what it read, and its
        // own write is already on its way.
        if (this.loaded && edits !== before) return;
        this._install(answer);
        this.loaded = true;
        this._writeBehind();
      } catch (cause) {
        this._failed("read the endpoints", cause);
      }
    },
    /** Start watching the configuration for changes to send. Once per store. */
    _writeBehind(): void {
      if (stopWatch) return;
      stopWatch = watch(
        () => JSON.stringify(this._config()),
        (now) => {
          edits++;
          // Back to what the server holds, with nothing on its way that says otherwise: there is
          // nothing to send. With a write out, the server may be about to hold something else,
          // so this has to be said too.
          if (now === held && !inFlight) return cancelTimer();
          cancelTimer();
          timer = setTimeout(() => void this.flushWrites(), WRITE_DELAY_MS);
        },
      );
    },
    /** Stop the write-behind and forget its bookkeeping. For tests, between one store and the next. */
    _detach(): void {
      stopWatch?.();
      stopWatch = null;
      cancelTimer();
      edits = 0;
      inFlight = 0;
      held = "";
    },
    /**
     * Send the configuration now rather than when the timer would have. Resolves when the answer
     * is in; a no-op when nothing is waiting to go.
     *
     * Only the answer to the latest change is installed: an earlier write answering after the
     * person has typed past it would put back what they typed over. A refused write is said, and
     * the server's configuration is read back so the page shows what is actually in force.
     */
    async flushWrites(): Promise<void> {
      const svc = this._service();
      if (!svc || !timer) return;
      cancelTimer();
      const n = edits;
      const body = this._config();
      const sent = JSON.stringify(body);
      // The count comes down before anything is installed: the watch sees an installed answer
      // after this returns, and while a write is counted as out it would send that answer back.
      inFlight++;
      let answer: EndpointSettings;
      try {
        answer = await svc.putSettings(body);
      } catch (cause) {
        inFlight--;
        if (edits !== n) return;
        this._failed("save the endpoints", cause);
        await this.load(true);
        return;
      }
      inFlight--;
      if (edits !== n) return;
      // The usual case: the server holds exactly what was sent, so there is nothing to put back on
      // the objects the page is editing.
      const { saved: _saved, ...rest } = answer;
      if (JSON.stringify({ ...rest, endpoints: rest.endpoints.map(storedOf) }) === sent)
        held = sent;
      else this._install(answer);
    },
    /**
     * Give the server a key for one endpoint or profile (`""` forgets it). Resolves true once the
     * server has answered.
     *
     * The key rides on the whole-configuration write, on that one entry only, and never touches
     * the objects the page edits: the write-behind sends those again and again, and an `apiKey`
     * left on one would go out with every write after it. So this writes now rather than behind —
     * with whatever else is waiting, which it therefore takes off the timer — and what comes back
     * is `hasKey`, which is all the page is ever told.
     */
    async saveKey(kind: EndpointKind, id: string, apiKey: string): Promise<boolean> {
      const svc = this._service();
      if (!svc) return false;
      const body = this._config();
      const entry = (kind === "tts" ? body.endpoints : body.profiles).find((e) => e.id === id);
      if (!entry) return false;
      entry.apiKey = apiKey;
      cancelTimer();
      const n = edits;
      inFlight++;
      let answer: EndpointSettings;
      try {
        answer = await svc.putSettings(body);
      } catch (cause) {
        inFlight--;
        this._failed(apiKey ? "save the key" : "remove the key", cause);
        if (edits === n) await this.load(true);
        return false;
      }
      inFlight--;
      if (edits === n) this._install(answer);
      else {
        // Typed past while the key was out: the rest of the answer is older than the page, but
        // whether a key is held is not something the page could have changed in the meantime.
        const list: (Endpoint | Profile)[] = kind === "tts" ? this.endpoints : this.profiles;
        const held = (kind === "tts" ? answer.endpoints : answer.profiles).find((e) => e.id === id);
        const cur = list.find((e) => e.id === id);
        if (cur && held?.hasKey) cur.hasKey = true;
        else if (cur) delete cur.hasKey;
      }
      return true;
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
      const failed = (message: string, detail: string): ConnectionTest => ({
        ok: false,
        at: Date.now(),
        ms: 0,
        message,
        detail,
        cost: null,
        simulated: false,
      });
      const svc = this._service();
      if (!svc) return failed("The test did not run", "There is no server to run it.");
      try {
        await this.flushWrites();
        const probe = await svc.testEndpoint(kind, id);
        return {
          ok: probe.ok,
          at: Date.now(),
          ms: probe.ms,
          message: probe.message,
          detail: probe.ms
            ? `The server's request took ${probe.ms} ms, with the settings and key it has saved.`
            : "The server made no request to the provider.",
          // the server reports no charge for its probe, and an estimate is not a receipt
          cost: null,
          simulated: false,
        };
      } catch (cause) {
        const api = cause instanceof ApiError ? cause : null;
        return failed(
          api?.status === 404 ? "Not saved on the server yet" : "The test did not run",
          api
            ? (api.detail ?? api.message)
            : cause instanceof Error
              ? cause.message
              : String(cause),
        );
      }
    },
    saveExpressionConfig(id: string, config: ExpressionConfig): boolean {
      const narrationStore = useNarrationStore();
      const uiStore = useUiStore();

      const ep = this.endpoints.find((e) => e.id === id);
      if (!ep || configErrors(config).length) return false;
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
    // ---------- settings (endpoints & profiles, keys excluded) ----------
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
      const profiles = (obj.profiles ?? []).map((imported) => {
        const existing = this.profiles.find((p) => p.id === imported?.id);
        // what the file says about a key is dropped: `hasKey` belongs to the server that wrote it,
        // and a key in the file would ride along on every write from here on
        const profile = newProfile({ ...existing, ...portable(imported ?? {}) });
        if (profileErrors(profile).length)
          throw new Error("Invalid scripting endpoint: " + profile.name);
        return profile;
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
        if (cur) Object.assign(cur, fresh);
        else this.endpoints.push(fresh);
        n++;
      }
      for (const p of profiles) {
        const cur = this.profiles.find((x) => x.id === p.id);
        if (cur) Object.assign(cur, p);
        else this.profiles.push(p);
      }
      if (obj.scriptSettings) Object.assign(scriptingStore.scriptSettings, obj.scriptSettings);
      uiStore.toast(`Imported ${n} narration and ${profiles.length} scripting endpoints`, {
        kind: "success",
        description: "API keys are never in the file — add them again on each endpoint.",
        timeout: 7000,
      });
    },
    addScriptProfile(): string {
      const p = newProfile();
      this.profiles.push(p);
      return p.id;
    },
    removeScriptProfile(id: string): void {
      const jobsStore = useJobsStore();
      const uiStore = useUiStore();

      if (jobsStore.jobs.some((j) => !j.finishedAt && j.scriptRun?.profile.id === id)) {
        uiStore.toast("Cancel this endpoint's jobs before removing it", { kind: "warn" });
        return;
      }
      const i = this.profiles.findIndex((p) => p.id === id);
      if (i < 0) return;
      const [p] = this.profiles.splice(i, 1);
      const secret = keyring.get("profile:" + id);
      keyring.set("profile:" + id, "");
      uiStore.toast(`Removed ${p.name}`, {
        undo: () => {
          this.profiles.splice(i, 0, p);
          keyring.set("profile:" + id, secret);
        },
      });
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
      this.endpoints.push(Object.assign(base, presetId ? presetById(presetId)?.apply : undefined));
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
    // Simulated voice discovery. Most OpenAI-compatible servers (Kokoro-FastAPI, Orpheus…) expose
    // GET /audio/voices; Fish Audio instead has a per-account model catalogue at the host root,
    // which is authenticated and returns far more than voices, so it is mapped down to the few
    // fields a voice picker needs.
    fetchVoices(ep: Endpoint): Promise<number> {
      const uiStore = useUiStore();

      const fish = isFishAudio(ep);
      const work = discoverVoices(ep);
      uiStore.toastLoading(work, {
        loading: `Fetching voices from ${ep.name}\u2026`,
        success: (n) =>
          n ? `${n} voice${n === 1 ? "" : "s"} added to ${ep.name}` : `${ep.name}: no new voices`,
        error: (e) =>
          fish && String(e).includes("401")
            ? `${ep.name}: set the API key first \u2014 the voice library is per account`
            : `${ep.name}: voice list unavailable`,
      });
      return work.catch(() => 0);
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
