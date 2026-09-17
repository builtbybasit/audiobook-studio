// Provider configurations and voice catalogues. Credentials remain in the keyring.
import { isFishAudio, presetById } from "@/lib/endpoints";
import { configErrors, expressionId } from "@/lib/expressions";
import { keyring } from "@/lib/keyring";
import { newProfile, profileErrors } from "@/lib/scripting";
import { GENDER } from "@/lib/scriptReview";
import { clone } from "@/lib/utils";
import { discoverVoices, voiceRef } from "@/mock";
import type {
  Endpoint,
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
}
export const useEndpointsStore = defineStore("endpoints", {
  state: (): EndpointsState => seedState("endpoints", "profiles"),
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
          }) => e,
        ),
        profiles: this.profiles.map((p) => ({ ...p })),
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
        const profile = newProfile({ ...existing, ...imported });
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
          ...e,
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
