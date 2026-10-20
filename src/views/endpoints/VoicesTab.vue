<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { SAMPLE_TITLE, sampleId, useVoiceSample } from "@/composables/useVoiceSample";
import { useLibraryStore } from "@/stores/library";
import { useUiStore } from "@/stores/ui";

// One speech endpoint's voice catalogue, the only place voices are added, edited or removed.
// Characters store `<endpoint>/<voice>`, so removing one unroutes speakers in every book; usage is
// counted library-wide. Voices come from the server's list, by hand, Fish search or cloning.
import { computed, reactive, ref, watch } from "vue";
import { keyInPlace } from "@/services/endpointSettings";
import {
  Archive as KeptIcon,
  AudioLines as SourceIcon,
  LoaderCircle as BusyIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Plus as AddIcon,
  RefreshCw as FetchIcon,
  TriangleAlert as WarnIcon,
  X as RemoveIcon,
  Search as SearchIcon,
} from "@lucide/vue";
import { UiHint, UiSelect, UiSwitch, UiTooltip } from "@/ui";
import { plural } from "@/lib/contents";
import { isFishAudio } from "@/lib/endpoints";
import { cloningOf, speechProviderOf } from "@/lib/providers";
import { MAX_SAMPLE_TEXT, SAMPLE_LINES } from "@/lib/endpointShapes";
import {
  pickProblem,
  requestOf,
  transcriptsMissing,
  type SampleRow,
} from "@/views/endpoints/cloneForm";
import CloneVoicePanel from "@/views/endpoints/CloneVoicePanel.vue";
import FishVoiceSearch from "@/views/endpoints/FishVoiceSearch.vue";
import { GENDER_ICON, GENDERS } from "@/views/endpoints/genders";
import SamplePicker from "@/views/endpoints/SamplePicker.vue";
import SpeedPicker from "@/components/SpeedPicker.vue";
import type { Endpoint, Gender, KeptVoiceSamples, Voice } from "@/types";

const props = defineProps<{ endpoint: Endpoint }>();
const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const libraryStore = useLibraryStore();

/** `voice id → book title → speaker names`, across every book. */
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

const fish = computed(() => isFishAudio(props.endpoint));
const needsKeyFirst = computed(() => props.endpoint.needsKey && !keyInPlace(props.endpoint));
const fetchBlocked = computed(() => fish.value && needsKeyFirst.value);

// keeping samples is held to the same provider limits as cloning
const cloning = computed(() => cloningOf(props.endpoint));
const clonable = computed(() => !!cloning.value);
// a compatible server may or may not clone; nothing says until it is asked
const cloningOptIn = computed(() => !!speechProviderOf(props.endpoint).cloning?.optIn);

// ---------- kept samples ----------
// The server can't tell a cloned voice without kept samples from any other, so every voice without
// them offers to keep them. The list is re-read whenever the voices change.
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

const keep = reactive({
  voiceId: null as string | null,
  samples: [] as SampleRow[],
  busy: false,
});
const keepVoice = computed(() => props.endpoint.voices.find((v) => v.id === keep.voiceId));
const keepProblem = computed(() =>
  cloning.value
    ? pickProblem(
        keep.samples.map((r) => r.file),
        cloning.value,
        speechProviderOf(props.endpoint).label,
      )
    : null,
);
const keepBlocked = computed(
  () =>
    !cloning.value ||
    !keep.samples.length ||
    !!keepProblem.value ||
    transcriptsMissing(keep.samples, cloning.value) ||
    keep.busy,
);
function openKeep(v: Voice) {
  Object.assign(keep, { voiceId: keep.voiceId === v.id ? null : v.id, samples: [] });
}
async function keepSamples() {
  if (keepBlocked.value || !keep.voiceId) return;
  keep.busy = true;
  try {
    const k = await endpointsStore.keepVoiceSamples(
      props.endpoint,
      keep.voiceId,
      requestOf(keep.samples),
    );
    if (k) {
      kept.value = { ...kept.value, [k.voiceId]: k };
      keep.voiceId = null;
    }
  } finally {
    keep.busy = false;
  }
}

// ---------- samples ----------
// The provider's own recording, or else a real, priced request made once and kept by the server.
// Each press says the next of `SAMPLE_LINES`, or the line typed above the list; a press while
// one plays pauses it.
const { loading: sampling, play: playSample, playUrl, playingId } = useVoiceSample();
const idOf = (v: Voice) => sampleId(props.endpoint.id, v.id);
const ownLine = ref("");
const nextLine: Record<string, number> = {};
/** what each voice's button last played, under its player id */
const heard = ref<Record<string, { id: string; text?: string }>>({});
const busyOn = (v: Voice) => !!sampling.value?.startsWith(idOf(v));
const playingOn = (v: Voice) => !!heard.value[v.id] && playingId(heard.value[v.id].id);
function preview(v: Voice) {
  let next = heard.value[v.id];
  if (!next || !playingId(next.id)) {
    const own = ownLine.value.trim();
    const n = nextLine[v.id] ?? 0;
    if (!own) nextLine[v.id] = (n + 1) % SAMPLE_LINES.length;
    next = own
      ? { id: `${idOf(v)}#own:${own}`, text: own }
      : { id: `${idOf(v)}#${n}`, ...(n ? { text: SAMPLE_LINES[n] } : {}) };
    heard.value = { ...heard.value, [v.id]: next };
  }
  return playSample(props.endpoint, v.id, v.label, next.id, next.text);
}
const sourceId = (v: Voice) => `source:${props.endpoint.id}/${v.id}`;
async function playSource(v: Voice, e: MouseEvent) {
  const k = kept.value[v.id];
  if (e.shiftKey) return copyTranscript(k);
  const url = k && (await endpointsStore.sourceRecording(props.endpoint, k));
  if (url) await playUrl(sourceId(v), url, `${v.label} · recording`);
}
// the first sample's, as that is the recording the button plays
const uiStore = useUiStore();
async function copyTranscript(k: KeptVoiceSamples) {
  const transcript = k.samples[0]?.transcript;
  if (!transcript) return uiStore.toast("No transcript kept for this recording");
  try {
    await navigator.clipboard.writeText(transcript);
    uiStore.toast("Transcript copied", { kind: "success", timeout: 2500 });
  } catch {
    uiStore.toast("Could not copy the transcript", { kind: "error" });
  }
}
const sampleTitle = computed(() =>
  needsKeyFirst.value
    ? "Save a key for this endpoint first: a sample is a real request"
    : SAMPLE_TITLE,
);
</script>

<template>
  <div class="space-y-3">
    <section class="card p-3">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="label mb-1">
            Voice catalogue
            <UiHint
              label="the voice catalogue"
              text="A character can only be given a voice that is on this list, which every book draws on."
            />
          </h3>
          <p class="text-[11px] leading-relaxed text-zinc-500">
            {{ plural(endpoint.voices.length, "voice") }} on <b>{{ endpoint.name }}</b
            ><span v-if="routed">, {{ routed }} assigned to a speaker somewhere</span>.
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
        <!-- a div, not a label: the hint is a button, so the input is named on its own -->
        <div class="space-y-1 text-xs font-medium">
          <span
            >Voice ID
            <UiHint
              label="the voice id"
              :text="
                fish
                  ? 'Fish Audio quotes a voice as a reference_id: a model from your library, or a public one found above.'
                  : 'Exactly what the provider expects in the request’s voice field; the label is yours.'
              "
          /></span>
          <input
            v-model="draft.id"
            class="input block w-48 font-mono"
            spellcheck="false"
            :placeholder="fish ? 'reference_id' : 'alloy'"
            aria-label="Voice ID"
            required
          />
        </div>
        <label class="space-y-1 text-xs font-medium"
          ><span>Label</span><input v-model="draft.label" class="input w-40" placeholder="optional"
        /></label>
        <label class="space-y-1 text-xs font-medium"
          ><span>Gender</span>
          <UiSelect v-model="draft.gender" :options="GENDERS" size="xs" class="w-32" />
        </label>
        <button class="btn-primary btn-xs" type="submit" :disabled="duplicate">Add</button>
        <p v-if="duplicate" class="w-full text-[11px] text-amber-600 dark:text-amber-400">
          This endpoint already has a voice with that id.
        </p>
      </form>

      <p
        v-if="needsKeyFirst"
        class="mt-2 rounded bg-amber-400/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300"
      >
        <WarnIcon class="icon-sm" /> No key is set: voices can be listed, but nothing renders with
        them until one is added on the Connection tab.
      </p>
    </section>

    <FishVoiceSearch v-if="fish" :endpoint="endpoint" />
    <section v-if="cloningOptIn" class="card flex items-center justify-between gap-3 p-3">
      <h3 class="label">
        Voice cloning
        <UiHint
          label="voice cloning"
          text="For a server that makes voices at POST /audio/voices, as omnivoice-fastapi does (the batch speech API). Kokoro and most others do not."
        />
      </h3>
      <UiSwitch
        :model-value="!!endpoint.makesVoices"
        label="Make voices on this server"
        @update:model-value="(v) => (endpoint.makesVoices = v)"
      />
    </section>
    <CloneVoicePanel :endpoint="endpoint" @cloned="loadKept" />

    <section class="card p-3">
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 class="label">
          Voices
          <UiHint
            label="the voices"
            text="Renaming a voice re-routes nothing, since the id is what is sent; removing one leaves its speakers unrouted in every book, undoable from the toast."
          />
        </h3>
        <div class="flex flex-wrap items-center gap-2">
          <input
            v-if="endpoint.voices.length"
            v-model="ownLine"
            class="input w-40 transition-[width] focus:w-72 not-placeholder-shown:w-72"
            :maxlength="MAX_SAMPLE_TEXT"
            placeholder="Preview line…"
            title="What Preview says. Left blank, each press says the next of a few built-in lines."
            aria-label="What Preview says"
          />
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
      </div>

      <p
        v-if="!endpoint.voices.length"
        class="rounded-lg border border-dashed border-zinc-300 px-3 py-6 text-center text-xs leading-relaxed text-zinc-500 dark:border-zinc-700"
      >
        No voices yet: fetch the server’s list, or add one by its id.
      </p>
      <p
        v-else-if="!shown.length"
        class="rounded-lg border border-dashed border-zinc-300 px-3 py-6 text-center text-xs text-zinc-500 dark:border-zinc-700"
      >
        No voice matches “{{ q }}”.
      </p>

      <div v-else class="label flex gap-2 pb-1">
        <span class="w-3 shrink-0"></span><span class="w-40">Label</span>
        <span class="w-14 shrink-0 whitespace-nowrap">
          Speed
          <UiHint
            label="a voice's speed"
            text="Speakers without a speed of their own use it. Sent to the voice’s service when it takes that speed, otherwise made here after the voice speaks."
          />
        </span>
      </div>
      <ul v-if="shown.length" class="divide-y divide-zinc-100 dark:divide-zinc-800">
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
          <SpeedPicker
            :model-value="v.speed ?? null"
            :label="`Speed for ${v.label}`"
            @update:model-value="(x) => endpointsStore.setVoiceSpeed(endpoint, v.id, x)"
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
          <UiTooltip v-if="countOf(v)" :text="usageTitle(v)">
            <span
              class="w-24 shrink-0 cursor-help text-right text-[11px] text-violet-600 dark:text-violet-300"
              >{{ plural(countOf(v), "speaker") }}</span
            >
          </UiTooltip>
          <span v-else class="w-24 shrink-0"></span>
          <template v-if="clonable">
            <button
              v-if="!kept[v.id]"
              class="btn-ghost btn-xs shrink-0"
              :aria-expanded="keep.voiceId === v.id"
              title="Keep the samples this voice was made from, so it can go with a book's script"
              @click="openKeep(v)"
            >
              Keep its samples…
            </button>
            <UiTooltip
              v-else
              text="The recording this voice was made from, not the voice itself · shift-click copies its transcript"
            >
              <button
                class="btn-ghost btn-xs shrink-0"
                :aria-label="`${playingId(sourceId(v)) ? 'Pause' : 'Play'} the recording ${v.label} was made from`"
                :disabled="!!sampling && sampling !== sourceId(v)"
                @click="playSource(v, $event)"
              >
                <PauseIcon v-if="playingId(sourceId(v))" class="icon-sm icon-fill" />
                <SourceIcon v-else class="icon-sm" />
              </button>
            </UiTooltip>
          </template>
          <button
            class="btn-ghost btn-xs shrink-0"
            :aria-label="`${playingOn(v) ? 'Pause' : 'Preview'} ${v.label}`"
            :title="sampleTitle"
            :disabled="needsKeyFirst || (!!sampling && !busyOn(v))"
            :aria-busy="busyOn(v)"
            @click="preview(v)"
          >
            <BusyIcon v-if="busyOn(v)" class="icon-sm animate-spin" />
            <PauseIcon v-else-if="playingOn(v)" class="icon-sm icon-fill" />
            <PlayIcon v-else class="icon-sm icon-fill" />
          </button>
          <button
            class="btn-ghost btn-xs shrink-0 hover:text-red-500"
            :aria-label="`Remove ${v.label}`"
            :title="
              (cloning?.deletes ? 'Delete on the server, for good' : 'Remove') +
              (countOf(v) ? ` — ${countOf(v)} speaker(s) lose their routing until repicked` : '')
            "
            @click="endpointsStore.removeVoice(endpoint, v.id)"
          >
            <RemoveIcon class="icon-sm" />
          </button>
        </li>
      </ul>

      <form
        v-if="keepVoice && cloning"
        class="mt-2 space-y-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50"
        @submit.prevent="keepSamples"
      >
        <p class="text-[11px] leading-relaxed text-zinc-500">
          Keep the samples <b>{{ keepVoice.label }}</b> was made from, so it can go with a book's
          script; nothing is sent to {{ endpoint.name }}.
        </p>
        <SamplePicker v-model="keep.samples" :cloning="cloning" />
        <p
          v-if="keepProblem"
          class="rounded bg-amber-400/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300"
          role="alert"
        >
          <WarnIcon class="icon-sm" /> {{ keepProblem }}
        </p>
        <div class="flex items-center gap-2">
          <button class="btn-primary btn-xs" type="submit" :disabled="keepBlocked">
            <KeptIcon class="icon-sm" /> {{ keep.busy ? "Keeping…" : "Keep samples" }}
          </button>
          <button class="btn-ghost btn-xs" type="button" @click="keep.voiceId = null">
            Cancel
          </button>
        </div>
      </form>
    </section>
  </div>
</template>
