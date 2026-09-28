<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { useUiStore } from "@/stores/ui";

// The voice catalogue of one speech endpoint — the only place voices are added, edited or removed.
//
// A voice is the one part of an endpoint that a book's cast points *at*: a character stores
// `<endpoint>/<voice>`, so removing a voice here unroutes speakers in every book that used it. That
// is why usage is counted across the whole library and shown next to each voice, rather than for
// whichever book happens to be open — this page has no book.
//
// Two ways in, because providers differ: fetch the server's list where there is one (Fish Audio's
// catalogue is per account and needs the key first), or type an id by hand for a server that has no
// list endpoint at all. With a server answering, a Fish endpoint has a third: search Fish's public
// catalogue and add a voice from the results.
import { computed, reactive, ref, watch } from "vue";
import {
  activeEndpointSettingsService,
  keyInPlace,
  type VoiceListPage,
} from "@/services/endpointSettings";
import { ApiError } from "@/services/http";
import { speak, usePlayer } from "@/composables/usePlayer";
import type { Component } from "vue";
import {
  Check as AddedIcon,
  ChevronLeft as PrevIcon,
  ChevronRight as NextIcon,
  Dot as NeutralIcon,
  Archive as KeptIcon,
  Globe as PublicIcon,
  Mic as CloneIcon,
  LoaderCircle as BusyIcon,
  Pause as PauseIcon,
  Mars as MaleIcon,
  Play as PlayIcon,
  Plus as AddIcon,
  RefreshCw as FetchIcon,
  Search as SearchIcon,
  TriangleAlert as WarnIcon,
  Venus as FemaleIcon,
  X as RemoveIcon,
} from "@lucide/vue";
import { UiCheckbox, UiSelect, UiTooltip } from "@/ui";
import { isFishAudio } from "@/lib/endpoints";
import { canCloneVoices, CLONE_CONSENT, MAX_CLONE_CLIPS, VOICE_SAMPLE } from "@/lib/endpointShapes";
import type { Endpoint, FoundVoice, Gender, KeptVoiceSamples, Voice } from "@/types";

const props = defineProps<{ endpoint: Endpoint }>();
const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const libraryStore = useLibraryStore();
const uiStore = useUiStore();

const GENDERS: { value: Gender; label: string }[] = [
  { value: "f", label: "female" },
  { value: "m", label: "male" },
  { value: "n", label: "neutral" },
  { value: "?", label: "unknown" },
];
const GENDER_ICON: Record<Gender, Component> = {
  m: MaleIcon,
  f: FemaleIcon,
  n: NeutralIcon,
  "?": NeutralIcon,
};

/** Who is using each voice, across every book — `voice id → book title → speaker names`. */
const usage = computed(() => {
  const out: Record<string, { book: string; speakers: string[] }[]> = {};
  for (const book of libraryStore.books) {
    for (const c of castStore.charactersOf(book.id)) {
      if (!c.voice) continue;
      const i = c.voice.indexOf("/");
      if (c.voice.slice(0, i) !== props.endpoint.id) continue;
      const rows = (out[c.voice.slice(i + 1)] ??= []);
      const row = rows.find((r) => r.book === book.title);
      if (row) row.speakers.push(c.name);
      else rows.push({ book: book.title, speakers: [c.name] });
    }
  }
  return out;
});
const usesOf = (v: Voice) => usage.value[v.id] ?? [];
const countOf = (v: Voice) => usesOf(v).reduce((n, r) => n + r.speakers.length, 0);
const usageTitle = (v: Voice) =>
  usesOf(v)
    .map((r) => `${r.book}: ${r.speakers.join(", ")}`)
    .join("\n");
const routed = computed(() => props.endpoint.voices.filter((v) => countOf(v) > 0).length);

const q = ref("");
const shown = computed(() => {
  const needle = q.value.trim().toLowerCase();
  if (!needle) return props.endpoint.voices;
  return props.endpoint.voices.filter((v) => `${v.label} ${v.id}`.toLowerCase().includes(needle));
});

// ---------- adding by hand ----------
const draft = reactive({ id: "", label: "", gender: "n" as Gender, open: false });
const duplicate = computed(
  () => !!draft.id.trim() && props.endpoint.voices.some((v) => v.id === draft.id.trim()),
);
function add() {
  if (endpointsStore.addVoice(props.endpoint, draft)) {
    draft.id = "";
    draft.label = "";
  }
}

// ---------- fetching ----------
const fish = computed(() => isFishAudio(props.endpoint));
const needsKeyFirst = computed(
  () => props.endpoint.needsKey && !keyInPlace(props.endpoint, props.endpoint.id),
);
const fetchBlocked = computed(() => fish.value && needsKeyFirst.value);

// ---------- searching the public catalogue ----------
// Fish Audio's public voices, a page at a time, through the server — which asks with the saved key.
// Only with a server answering: the demo has no catalogue to search. A result is only a result
// until "Add" puts it on this endpoint, and the write-behind saves it like any other voice.
const searchable = computed(() => fish.value && !!activeEndpointSettingsService());
const LANGUAGES = [
  { value: "", label: "Any language" },
  { value: "en", label: "English" },
  { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "es", label: "Spanish" },
  { value: "pt", label: "Portuguese" },
  { value: "it", label: "Italian" },
  { value: "ru", label: "Russian" },
  { value: "ar", label: "Arabic" },
];
const search = reactive({
  query: "",
  language: "en",
  busy: false,
  error: "",
  result: null as VoiceListPage | null,
});
/** Only the latest search's answer is shown; an earlier one arriving late is dropped. */
let searches = 0;
async function runSearch(page = 1) {
  const n = ++searches;
  search.busy = true;
  search.error = "";
  try {
    const result = await endpointsStore.searchVoices(props.endpoint, {
      query: search.query.trim() || undefined,
      language: search.language || undefined,
      page,
    });
    if (n === searches) search.result = result;
  } catch (e) {
    if (n !== searches) return;
    search.result = null;
    search.error =
      e instanceof ApiError && e.status === 404
        ? "This endpoint is not saved on the server yet."
        : e instanceof Error
          ? e.message
          : String(e);
  } finally {
    if (n === searches) search.busy = false;
  }
}
const has = (v: Voice) => props.endpoint.voices.some((x) => x.id === v.id);

// ---------- cloning ----------
// A voice made from someone's recordings, kept by the provider as a private voice on the account
// and added to this endpoint like any other. Only where the provider keeps one (`canCloneVoices`)
// and a server is answering: the recordings go to the provider through it, with the saved key, and
// the server keeps them beside the voice with the consent they were given under — so the voice can
// travel with a book's script to someone who has to make it again.
//
// The picker offers the formats Fish documents for a voice sample, and the server decides by each
// file's first bytes rather than its name, so a renamed file is refused there with its name.
const CLIP_TYPES = ".wav,.mp3,.m4a,.opus,.ogg,.flac";
const clonable = computed(
  () => canCloneVoices(props.endpoint) && !!activeEndpointSettingsService(),
);
const clone = reactive({
  title: "",
  clips: [] as File[],
  /** how many picked recordings were left out, past the most one voice is made from */
  leftOut: 0,
  consent: false,
  busy: false,
});
const clipsInput = ref<HTMLInputElement | null>(null);
const clipsSize = computed(() => clone.clips.reduce((n, f) => n + f.size, 0));
const cloneBlocked = computed(
  () =>
    !clone.title.trim() ||
    !clone.clips.length ||
    !clone.consent ||
    clone.busy ||
    needsKeyFirst.value,
);
/** The recordings a file input holds, up to the most one voice is made from, and how many were not. */
function picked(e: Event): { clips: File[]; leftOut: number } {
  const all = [...((e.target as HTMLInputElement).files ?? [])];
  const clips = all.slice(0, MAX_CLONE_CLIPS);
  return { clips, leftOut: all.length - clips.length };
}
function pickClips(e: Event) {
  Object.assign(clone, picked(e));
}
async function makeVoice() {
  if (cloneBlocked.value) return;
  clone.busy = true;
  try {
    const voice = await endpointsStore.cloneVoice(props.endpoint, {
      title: clone.title,
      clips: clone.clips,
      consent: clone.consent,
    });
    if (voice) {
      clone.title = "";
      clone.clips = [];
      clone.leftOut = 0;
      clone.consent = false;
      if (clipsInput.value) clipsInput.value.value = "";
      void loadKept();
    }
  } finally {
    clone.busy = false;
  }
}

// ---------- kept recordings ----------
// Which voices here have the recordings they were made from kept on the server. A voice cloned
// before recordings were kept has none, and the server cannot tell it from any other voice on the
// account — so every voice without them offers to keep them, under the same consent as a clone.
// Removing a voice from this list keeps its recordings for a day, so the removal's Undo brings them
// back with it; a save after that takes them. The list is asked again whenever the voices change,
// which is how a voice put back by an Undo shows its recordings again.
const kept = ref<Record<string, KeptVoiceSamples>>({});
async function loadKept() {
  const list = clonable.value ? await endpointsStore.keptSamples(props.endpoint) : [];
  kept.value = Object.fromEntries(list.map((k) => [k.voiceId, k]));
}
watch(
  () => [props.endpoint.id, clonable.value, props.endpoint.voices.map((v) => v.id).join("\0")],
  loadKept,
  { immediate: true },
);
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const keptTitle = (k: KeptVoiceSamples) =>
  `${k.samples.length} recording${k.samples.length === 1 ? "" : "s"} kept on this server, ${megabytes(
    k.samples.reduce((n, x) => n + x.bytes, 0),
  )}. Consent given ${new Date(k.consentAt).toLocaleDateString()}: “${k.consentText}”`;

const keep = reactive({
  voiceId: null as string | null,
  clips: [] as File[],
  leftOut: 0,
  consent: false,
  busy: false,
});
const keepVoice = computed(() => props.endpoint.voices.find((v) => v.id === keep.voiceId));
const keepBlocked = computed(() => !keep.clips.length || !keep.consent || keep.busy);
function openKeep(v: Voice) {
  Object.assign(keep, { voiceId: keep.voiceId === v.id ? null : v.id, clips: [], leftOut: 0 });
  keep.consent = false;
}
function pickKept(e: Event) {
  Object.assign(keep, picked(e));
}
async function keepSamples() {
  if (keepBlocked.value || !keep.voiceId) return;
  keep.busy = true;
  try {
    const k = await endpointsStore.keepVoiceSamples(props.endpoint, keep.voiceId, {
      clips: keep.clips,
      consent: keep.consent,
    });
    if (k) {
      kept.value = { ...kept.value, [k.voiceId]: k };
      keep.voiceId = null;
    }
  } finally {
    keep.busy = false;
  }
}
async function forgetKept(v: Voice) {
  const k = kept.value[v.id];
  if (!k) return;
  const restored = (back: KeptVoiceSamples) => (kept.value = { ...kept.value, [v.id]: back });
  if (!(await endpointsStore.forgetVoiceSamples(props.endpoint, k, restored))) return;
  const { [v.id]: _, ...rest } = kept.value;
  kept.value = rest;
}

// ---------- samples ----------
// With a server answering, play is the saved endpoint saying a sentence in that voice: a real,
// priced request, heard once and replayed from then on (`endpointsStore.sampleVoice`). The demo
// has no provider to ask, so it falls back on the browser's own voice.
const player = usePlayer();
const onServer = !!activeEndpointSettingsService();
const sampling = ref<string | null>(null);
const sampleId = (v: Voice) => `sample:${props.endpoint.id}/${v.id}`;
const playingSample = (v: Voice) => player.p.id === sampleId(v) && player.p.playing;
const sampleTitle = computed(() =>
  !onServer
    ? "preview with the browser’s own voice — the provider is never called"
    : needsKeyFirst.value
      ? "Save a key for this endpoint first: a sample is a real request"
      : "Hear this voice from the provider — a real request, billed once and replayed after",
);
async function playSample(v: Voice) {
  if (!onServer) return speak(VOICE_SAMPLE, v.id);
  if (sampling.value) return;
  sampling.value = v.id;
  try {
    const sample = await endpointsStore.sampleVoice(props.endpoint, v.id);
    if (sample) player.play(sampleId(v), sample.duration, sample.url);
  } finally {
    sampling.value = null;
  }
}

// A public Fish voice found by the search plays Fish's own recording of it: a file on Fish's CDN,
// free, nothing rendered. One that has none is rendered by this endpoint like a listed voice.
const foundId = (v: FoundVoice) => `found:${props.endpoint.id}/${v.id}`;
const playingFound = (v: FoundVoice) => player.p.id === foundId(v) && player.p.playing;
const foundTitle = (v: FoundVoice) => {
  if (!v.sample)
    return "Fish has no sample of this voice — hear it from this endpoint: a real request, billed once and replayed after";
  const said = v.sample.text.length > 120 ? `${v.sample.text.slice(0, 119)}…` : v.sample.text;
  return `Fish's own sample${said ? `: “${said}”` : ""} — free, nothing is rendered`;
};
async function playFound(v: FoundVoice) {
  if (sampling.value) return;
  sampling.value = foundId(v);
  try {
    if (v.sample) await player.playFile(foundId(v), v.sample.url, v.label);
    else {
      const sample = await endpointsStore.sampleVoice(props.endpoint, v.id);
      if (sample) player.play(foundId(v), sample.duration, sample.url);
    }
  } catch (e) {
    uiStore.toast(`Could not play the sample of ${v.label}`, {
      kind: "error",
      description: e instanceof Error ? e.message : undefined,
    });
  } finally {
    sampling.value = null;
  }
}
</script>

<template>
  <div class="space-y-3">
    <section class="card p-3">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="label mb-1">Voice catalogue</h3>
          <p class="text-[11px] leading-relaxed text-zinc-500">
            {{ endpoint.voices.length }} voice{{ endpoint.voices.length === 1 ? "" : "s" }} on
            <b>{{ endpoint.name }}</b
            ><span v-if="routed">, {{ routed }} of them assigned to a speaker somewhere</span>. A
            character can only be given a voice that exists here, and every book draws on this one
            list.
          </p>
        </div>
        <div class="flex shrink-0 flex-wrap gap-2">
          <UiTooltip
            :text="
              fetchBlocked
                ? 'Fish Audio’s voice library is per account — set the API key on the Connection tab first.'
                : `Asks ${endpoint.name} for its voice list and adds anything new. Nothing already here is removed.`
            "
          >
            <button
              class="btn-ghost btn-xs"
              :disabled="endpoint.fetching || fetchBlocked"
              @click="endpointsStore.fetchVoices(endpoint)"
            >
              <FetchIcon class="icon-sm" :class="endpoint.fetching && 'animate-spin'" />
              {{ endpoint.fetching ? "Fetching…" : "Fetch from server" }}
            </button>
          </UiTooltip>
          <button class="btn-ghost btn-xs" @click="draft.open = !draft.open">
            <AddIcon class="icon-sm" /> {{ draft.open ? "Close" : "Add voice" }}
          </button>
        </div>
      </div>

      <form
        v-if="draft.open"
        class="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50"
        @submit.prevent="add"
      >
        <label class="space-y-1 text-xs font-medium"
          ><span>Voice ID</span
          ><input
            v-model="draft.id"
            class="input w-48 font-mono"
            spellcheck="false"
            :placeholder="fish ? 'reference_id' : 'alloy'"
            required
        /></label>
        <label class="space-y-1 text-xs font-medium"
          ><span>Label</span><input v-model="draft.label" class="input w-40" placeholder="optional"
        /></label>
        <label class="space-y-1 text-xs font-medium"
          ><span>Gender</span>
          <UiSelect v-model="draft.gender" :options="GENDERS" size="xs" class="w-32" />
        </label>
        <button class="btn-primary btn-xs" type="submit" :disabled="duplicate">Add</button>
        <p class="w-full text-[11px] text-zinc-500">
          <template v-if="duplicate"
            ><span class="text-amber-600 dark:text-amber-400"
              >This endpoint already has a voice with that id.</span
            ></template
          >
          <template v-else-if="fish"
            >Fish Audio quotes a voice as a <code class="font-mono">reference_id</code> — a model
            from your library or a public one, found by searching above.</template
          >
          <template v-else
            >Exactly what the provider expects in the request’s
            <code class="font-mono">voice</code> field. The label is yours; gender only steers
            auto-assignment.</template
          >
        </p>
      </form>

      <p
        v-if="needsKeyFirst"
        class="mt-2 rounded bg-amber-400/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300"
      >
        <WarnIcon class="icon-sm" /> No key is set for this endpoint. Voices can still be listed
        here, but nothing routed to them renders until one is added on the Connection tab.
      </p>
    </section>

    <section v-if="searchable" class="card p-3">
      <h3 class="label mb-1"><PublicIcon class="icon-sm" /> Public voices</h3>
      <p class="mb-2 text-[11px] leading-relaxed text-zinc-500">
        Search Fish Audio’s public catalogue by title, or paste a voice’s id to find that one. Best
        rated first. Adding one puts it in this endpoint’s list; it is spoken with like your own.
      </p>
      <form class="flex flex-wrap items-center gap-2" @submit.prevent="runSearch(1)">
        <div class="relative min-w-48 flex-1">
          <SearchIcon
            class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400 icon"
          />
          <input
            v-model="search.query"
            class="input w-full pl-7!"
            placeholder="narrator, calm, old man… or a voice id"
            aria-label="Search Fish Audio's public voices"
            spellcheck="false"
          />
        </div>
        <UiSelect
          v-model="search.language"
          :options="LANGUAGES"
          size="xs"
          class="w-36"
          aria-label="Language the voices speak"
        />
        <button
          class="btn-primary btn-xs"
          type="submit"
          :disabled="search.busy || needsKeyFirst"
          :title="needsKeyFirst ? 'Set the API key on the Connection tab first' : undefined"
        >
          <SearchIcon class="icon-sm" /> {{ search.busy ? "Searching…" : "Search" }}
        </button>
      </form>

      <p
        v-if="search.error"
        class="mt-2 rounded bg-red-500/10 px-2 py-1 text-[11px] text-red-700 dark:text-red-300"
        role="alert"
      >
        {{ search.error }}
      </p>
      <template v-else-if="search.result">
        <p
          v-if="!search.result.voices.length"
          class="mt-2 rounded-lg border border-dashed border-zinc-300 px-3 py-4 text-center text-xs text-zinc-500 dark:border-zinc-700"
        >
          No public voice matches that{{ search.language ? " in that language" : "" }}.
        </p>
        <ul v-else class="mt-2 divide-y divide-zinc-100 dark:divide-zinc-800">
          <li
            v-for="v in search.result.voices"
            :key="v.id"
            class="flex flex-wrap items-center gap-2 py-1.5 text-sm"
          >
            <component :is="GENDER_ICON[v.gender]" class="icon-sm shrink-0 text-zinc-400" />
            <span class="min-w-0 flex-1 truncate" :title="v.label">{{ v.label }}</span>
            <span
              class="hidden w-40 shrink-0 truncate font-mono text-[11px] text-zinc-500 sm:inline"
              :title="v.id"
              >{{ v.id }}</span
            >
            <button
              class="btn-ghost btn-xs shrink-0"
              :aria-label="`${playingFound(v) ? 'Pause' : 'Preview'} ${v.label}`"
              :title="foundTitle(v)"
              :disabled="!!sampling && sampling !== foundId(v)"
              :aria-busy="sampling === foundId(v)"
              @click="playFound(v)"
            >
              <BusyIcon v-if="sampling === foundId(v)" class="icon-sm animate-spin" />
              <PauseIcon v-else-if="playingFound(v)" class="icon-sm icon-fill" />
              <PlayIcon v-else class="icon-sm icon-fill" />
            </button>
            <button
              class="btn-ghost btn-xs shrink-0"
              :disabled="has(v)"
              :aria-label="has(v) ? `${v.label} is on this endpoint` : `Add ${v.label}`"
              @click="endpointsStore.addVoice(endpoint, v)"
            >
              <component :is="has(v) ? AddedIcon : AddIcon" class="icon-sm" />
              {{ has(v) ? "Added" : "Add" }}
            </button>
          </li>
        </ul>
        <div
          v-if="search.result.page > 1 || search.result.hasMore"
          class="mt-2 flex items-center justify-between gap-2 text-[11px] text-zinc-500"
        >
          <button
            class="btn-ghost btn-xs"
            :disabled="search.busy || search.result.page <= 1"
            @click="runSearch(search.result.page - 1)"
          >
            <PrevIcon class="icon-sm" /> Previous
          </button>
          <span
            >Page {{ search.result.page }} · {{ search.result.total.toLocaleString() }} match{{
              search.result.total === 1 ? "" : "es"
            }}</span
          >
          <button
            class="btn-ghost btn-xs"
            :disabled="search.busy || !search.result.hasMore"
            @click="runSearch(search.result.page + 1)"
          >
            Next <NextIcon class="icon-sm" />
          </button>
        </div>
      </template>
    </section>

    <section v-if="clonable" class="card p-3">
      <h3 class="label mb-1"><CloneIcon class="icon-sm" /> Clone a voice</h3>
      <p class="text-[11px] leading-relaxed text-zinc-500">
        Make a voice from recordings of one person speaking — your own, or any you have the right to
        use. {{ endpoint.name }} keeps it as a private voice on your account, and it is added to
        this list. The recordings are kept on this server with the voice and your consent, so the
        voice can go with a book's script. Fish recommends two or three clips of 15–20 seconds each,
        at least 10 seconds in all: one speaker, a quiet room, an even tone. It transcribes them
        itself. WAV, MP3, M4A, Opus or FLAC; up to {{ MAX_CLONE_CLIPS }} recordings.
      </p>
      <form class="mt-2 space-y-2" @submit.prevent="makeVoice">
        <div class="flex flex-wrap items-end gap-2">
          <label class="space-y-1 text-xs font-medium"
            ><span>Name</span
            ><input
              v-model="clone.title"
              class="input w-56"
              maxlength="100"
              placeholder="Narrator — Mara"
          /></label>
          <label class="space-y-1 text-xs font-medium"
            ><span>Recordings</span
            ><input
              ref="clipsInput"
              type="file"
              :accept="CLIP_TYPES"
              multiple
              class="block text-xs"
              @change="pickClips"
          /></label>
          <span v-if="clone.clips.length" class="text-[11px] text-zinc-500">
            {{ clone.clips.length }} recording{{ clone.clips.length === 1 ? "" : "s" }},
            {{ (clipsSize / 1024 / 1024).toFixed(1) }} MB
          </span>
          <span v-if="clone.leftOut" class="text-[11px] text-amber-600 dark:text-amber-400">
            Only the first {{ MAX_CLONE_CLIPS }} are used: {{ clone.leftOut }} left out.
          </span>
        </div>
        <label class="flex items-start gap-2 text-xs">
          <UiCheckbox v-model="clone.consent" />
          <span>{{ CLONE_CONSENT }}</span>
        </label>
        <div class="flex items-center gap-2">
          <button class="btn-primary btn-xs" type="submit" :disabled="cloneBlocked">
            <CloneIcon class="icon-sm" /> {{ clone.busy ? "Making the voice…" : "Make voice" }}
          </button>
          <span v-if="needsKeyFirst" class="text-[11px] text-amber-600 dark:text-amber-400"
            >Save a key for this endpoint first.</span
          >
        </div>
      </form>
    </section>

    <section class="card p-3">
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 class="label">Voices</h3>
        <div v-if="endpoint.voices.length > 8" class="relative">
          <SearchIcon
            class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400 icon"
          />
          <input
            v-model="q"
            class="input w-48 pl-7!"
            placeholder="Filter voices…"
            aria-label="Filter voices by name or id"
          />
        </div>
      </div>

      <p
        v-if="!endpoint.voices.length"
        class="rounded-lg border border-dashed border-zinc-300 px-3 py-6 text-center text-xs leading-relaxed text-zinc-500 dark:border-zinc-700"
      >
        No voices yet. Fetch the server’s list, or add one by its id — until this endpoint has at
        least one, no speaker in any book can be routed to it.
      </p>
      <p
        v-else-if="!shown.length"
        class="rounded-lg border border-dashed border-zinc-300 px-3 py-6 text-center text-xs text-zinc-500 dark:border-zinc-700"
      >
        No voice matches “{{ q }}”.
      </p>

      <ul v-else class="divide-y divide-zinc-100 dark:divide-zinc-800">
        <li
          v-for="v in shown"
          :key="v.id"
          class="flex flex-wrap items-center gap-2 py-1.5 text-sm"
          :class="countOf(v) ? 'bg-violet-50/50 dark:bg-violet-500/5' : ''"
        >
          <component :is="GENDER_ICON[v.gender]" class="icon-sm shrink-0 text-zinc-400" />
          <input
            v-model="v.label"
            class="input w-40 py-0.5"
            :aria-label="`Label for voice ${v.id}`"
          />
          <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-500" :title="v.id">{{
            v.id
          }}</span>
          <UiSelect
            :model-value="v.gender"
            :options="GENDERS"
            size="xs"
            class="w-28 shrink-0"
            :aria-label="`Gender for ${v.label}`"
            @update:model-value="(g) => (v.gender = g as Gender)"
          />
          <UiTooltip
            :text="
              countOf(v)
                ? usageTitle(v)
                : 'Not assigned to any speaker. Removing it affects nothing.'
            "
          >
            <span
              class="w-24 shrink-0 cursor-help text-right text-[11px]"
              :class="countOf(v) ? 'text-violet-600 dark:text-violet-300' : 'text-zinc-400'"
              >{{
                countOf(v) ? `${countOf(v)} speaker${countOf(v) === 1 ? "" : "s"}` : "unused"
              }}</span
            >
          </UiTooltip>
          <template v-if="clonable">
            <UiTooltip v-if="kept[v.id]" :text="keptTitle(kept[v.id])">
              <span
                class="flex shrink-0 cursor-help items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400"
                ><KeptIcon class="icon-sm" />{{ kept[v.id].samples.length }} sample{{
                  kept[v.id].samples.length === 1 ? "" : "s"
                }}
                kept</span
              >
            </UiTooltip>
            <button
              v-if="kept[v.id]"
              class="btn-ghost btn-xs shrink-0 hover:text-red-500"
              :aria-label="`Forget the recordings kept for ${v.label}`"
              title="Forget the recordings kept for this voice — the voice stays"
              @click="forgetKept(v)"
            >
              <RemoveIcon class="icon-sm" /> Forget
            </button>
            <button
              v-else
              class="btn-ghost btn-xs shrink-0"
              :aria-expanded="keep.voiceId === v.id"
              title="Keep the recordings this voice was made from, so it can go with a book's script"
              @click="openKeep(v)"
            >
              Keep its samples…
            </button>
          </template>
          <button
            class="btn-ghost btn-xs shrink-0"
            :aria-label="`${playingSample(v) ? 'Pause' : 'Preview'} ${v.label}`"
            :title="sampleTitle"
            :disabled="(onServer && needsKeyFirst) || (!!sampling && sampling !== v.id)"
            :aria-busy="sampling === v.id"
            @click="playSample(v)"
          >
            <BusyIcon v-if="sampling === v.id" class="icon-sm animate-spin" />
            <PauseIcon v-else-if="playingSample(v)" class="icon-sm icon-fill" />
            <PlayIcon v-else class="icon-sm icon-fill" />
          </button>
          <button
            class="btn-ghost btn-xs shrink-0 hover:text-red-500"
            :aria-label="`Remove ${v.label}`"
            :title="
              countOf(v)
                ? `Remove — ${countOf(v)} speaker(s) lose their routing until repicked`
                : 'Remove'
            "
            @click="endpointsStore.removeVoice(endpoint, v.id)"
          >
            <RemoveIcon class="icon-sm" />
          </button>
        </li>
      </ul>

      <form
        v-if="keepVoice"
        class="mt-2 space-y-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50"
        @submit.prevent="keepSamples"
      >
        <p class="text-[11px] leading-relaxed text-zinc-500">
          Keep the recordings <b>{{ keepVoice.label }}</b> was made from, so it can go with a book's
          script to someone who has to make it again. Nothing is sent to {{ endpoint.name }}. WAV,
          MP3, M4A, Opus or FLAC; up to {{ MAX_CLONE_CLIPS }} recordings.
        </p>
        <div class="flex flex-wrap items-end gap-2">
          <label class="space-y-1 text-xs font-medium"
            ><span>Recordings</span
            ><input
              type="file"
              :accept="CLIP_TYPES"
              multiple
              class="block text-xs"
              @change="pickKept"
          /></label>
          <span v-if="keep.clips.length" class="text-[11px] text-zinc-500">
            {{ keep.clips.length }} recording{{ keep.clips.length === 1 ? "" : "s" }},
            {{ megabytes(keep.clips.reduce((n, f) => n + f.size, 0)) }}
          </span>
          <span v-if="keep.leftOut" class="text-[11px] text-amber-600 dark:text-amber-400">
            Only the first {{ MAX_CLONE_CLIPS }} are used: {{ keep.leftOut }} left out.
          </span>
        </div>
        <label class="flex items-start gap-2 text-xs">
          <UiCheckbox v-model="keep.consent" />
          <span>{{ CLONE_CONSENT }}</span>
        </label>
        <div class="flex items-center gap-2">
          <button class="btn-primary btn-xs" type="submit" :disabled="keepBlocked">
            <KeptIcon class="icon-sm" /> {{ keep.busy ? "Keeping…" : "Keep recordings" }}
          </button>
          <button class="btn-ghost btn-xs" type="button" @click="keep.voiceId = null">
            Cancel
          </button>
        </div>
      </form>

      <p class="mt-2 text-[11px] leading-relaxed text-zinc-500">
        Labels and gender are yours to change and take effect at once — the id is what goes in the
        request, so renaming a voice re-routes nothing. Removing one leaves the speakers that used
        it unrouted in every book, and is undoable from the toast; any recordings kept for it are
        held for a day in case it comes back, then go.
      </p>
    </section>
  </div>
</template>
