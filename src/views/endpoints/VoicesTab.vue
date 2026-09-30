<script setup lang="ts">
import { sizeLabel } from "@/lib/audioFormat";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { SAMPLE_TITLE, sampleId, useVoiceSample } from "@/composables/useVoiceSample";
import { useLibraryStore } from "@/stores/library";

// The voice catalogue of one speech endpoint — the only place voices are added, edited or removed.
//
// A voice is the one part of an endpoint that a book's cast points *at*: a character stores
// `<endpoint>/<voice>`, so removing a voice here unroutes speakers in every book that used it. That
// is why usage is counted across the whole library and shown next to each voice, rather than for
// whichever book happens to be open — this page has no book.
//
// Two ways in, because providers differ: fetch the server's list where there is one (Fish Audio's
// catalogue is per account and needs the key first), or type an id by hand for a server that has no
// list endpoint at all. A Fish endpoint has a third: search Fish's public catalogue and add a voice
// from the results (`FishVoiceSearch`). Where the provider clones, a fourth makes one from samples
// (`CloneVoicePanel`).
import { computed, reactive, ref, watch } from "vue";
import { keyInPlace } from "@/services/endpointSettings";
import {
  Archive as KeptIcon,
  LoaderCircle as BusyIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Plus as AddIcon,
  RefreshCw as FetchIcon,
  TriangleAlert as WarnIcon,
  X as RemoveIcon,
  Search as SearchIcon,
} from "@lucide/vue";
import { UiCheckbox, UiSelect, UiTooltip } from "@/ui";
import { plural } from "@/lib/contents";
import { isFishAudio } from "@/lib/endpoints";
import { CLONE_CONSENT } from "@/lib/endpointShapes";
import { cloningOf, speechProviderOf } from "@/lib/providers";
import {
  acceptOf,
  leftOutSaid,
  limitsSaid,
  pickOf,
  pickProblem,
} from "@/views/endpoints/cloneForm";
import CloneVoicePanel from "@/views/endpoints/CloneVoicePanel.vue";
import FishVoiceSearch from "@/views/endpoints/FishVoiceSearch.vue";
import { GENDER_ICON, GENDERS } from "@/views/endpoints/genders";
import { maxSamplesOf } from "@/lib/voiceSamples";
import type { Endpoint, Gender, KeptVoiceSamples, Voice } from "@/types";

const props = defineProps<{ endpoint: Endpoint }>();
const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const libraryStore = useLibraryStore();

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
const needsKeyFirst = computed(() => props.endpoint.needsKey && !keyInPlace(props.endpoint));
const fetchBlocked = computed(() => fish.value && needsKeyFirst.value);

// what the provider takes as a voice's samples, which keeping them is held to as cloning is
const cloning = computed(() => cloningOf(props.endpoint));
const clonable = computed(() => !!cloning.value);

// ---------- kept samples ----------
// Which voices here have the samples they were made from kept on the server. A voice cloned before
// samples were kept has none, and the server cannot tell it from any other voice on the account —
// so every voice without them offers to keep them, under the same consent and the same provider
// limits as a clone. Removing a voice from this list keeps its samples for a day, so the removal's
// Undo brings them back with it; a save after that takes them. The list is asked again whenever the
// voices change, which is how a voice put back by an Undo shows its samples again.
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
const keptTitle = (k: KeptVoiceSamples) =>
  `${plural(k.samples.length, "sample")} kept on this server, ${sizeLabel(
    k.samples.reduce((n, x) => n + x.bytes, 0),
  )}. Consent given ${new Date(k.consentAt).toLocaleDateString()}: “${k.consentText}”`;

const keep = reactive({
  voiceId: null as string | null,
  samples: [] as File[],
  leftOut: 0,
  consent: false,
  busy: false,
});
const keepVoice = computed(() => props.endpoint.voices.find((v) => v.id === keep.voiceId));
/** Why the picked samples cannot be kept, naming the file; null when nothing stops them. */
const keepProblem = computed(() =>
  cloning.value
    ? pickProblem(keep.samples, cloning.value, speechProviderOf(props.endpoint).label)
    : null,
);
const keepBlocked = computed(
  () => !keep.samples.length || !!keepProblem.value || !keep.consent || keep.busy,
);
function openKeep(v: Voice) {
  Object.assign(keep, { voiceId: keep.voiceId === v.id ? null : v.id, samples: [], leftOut: 0 });
  keep.consent = false;
}
/** The samples picked, up to the most one voice is made from, and how many were not. */
function pickKept(e: Event) {
  const all = [...((e.target as HTMLInputElement).files ?? [])];
  Object.assign(
    keep,
    cloning.value ? pickOf(all, cloning.value) : { samples: [], leftOut: all.length },
  );
}
async function keepSamples() {
  if (keepBlocked.value || !keep.voiceId) return;
  keep.busy = true;
  try {
    const k = await endpointsStore.keepVoiceSamples(props.endpoint, keep.voiceId, {
      samples: keep.samples,
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
// Play is the provider's own recording of the voice where it keeps one, or else the saved endpoint
// saying a sentence in it: a real, priced request, made once and kept by the server from then on
// (`endpointsStore.sampleVoice`).
/** the sample being fetched, if any — one at a time */
const { loading: sampling, play: playSample, playingId } = useVoiceSample();
const idOf = (v: Voice) => sampleId(props.endpoint.id, v.id);
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
          <h3 class="label mb-1">Voice catalogue</h3>
          <p class="text-[11px] leading-relaxed text-zinc-500">
            {{ plural(endpoint.voices.length, "voice") }} on <b>{{ endpoint.name }}</b
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

    <FishVoiceSearch v-if="fish" :endpoint="endpoint" />
    <CloneVoicePanel :endpoint="endpoint" @cloned="loadKept" />

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
              >{{ countOf(v) ? plural(countOf(v), "speaker") : "unused" }}</span
            >
          </UiTooltip>
          <template v-if="clonable">
            <UiTooltip v-if="kept[v.id]" :text="keptTitle(kept[v.id])">
              <span
                class="flex shrink-0 cursor-help items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400"
                ><KeptIcon class="icon-sm" />{{
                  plural(kept[v.id].samples.length, "sample")
                }}
                kept</span
              >
            </UiTooltip>
            <button
              v-if="kept[v.id]"
              class="btn-ghost btn-xs shrink-0 hover:text-red-500"
              :aria-label="`Forget the samples kept for ${v.label}`"
              title="Forget the samples kept for this voice — the voice stays"
              @click="forgetKept(v)"
            >
              <RemoveIcon class="icon-sm" /> Forget
            </button>
            <button
              v-else
              class="btn-ghost btn-xs shrink-0"
              :aria-expanded="keep.voiceId === v.id"
              title="Keep the samples this voice was made from, so it can go with a book's script"
              @click="openKeep(v)"
            >
              Keep its samples…
            </button>
          </template>
          <button
            class="btn-ghost btn-xs shrink-0"
            :aria-label="`${playingId(idOf(v)) ? 'Pause' : 'Preview'} ${v.label}`"
            :title="sampleTitle"
            :disabled="needsKeyFirst || (!!sampling && sampling !== idOf(v))"
            :aria-busy="sampling === idOf(v)"
            @click="playSample(endpoint, v.id, v.label)"
          >
            <BusyIcon v-if="sampling === idOf(v)" class="icon-sm animate-spin" />
            <PauseIcon v-else-if="playingId(idOf(v))" class="icon-sm icon-fill" />
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
        v-if="keepVoice && cloning"
        class="mt-2 space-y-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50"
        @submit.prevent="keepSamples"
      >
        <p class="text-[11px] leading-relaxed text-zinc-500">
          Keep the samples <b>{{ keepVoice.label }}</b> was made from, so it can go with a book's
          script to someone who has to make it again. Nothing is sent to {{ endpoint.name }}.
          {{ limitsSaid(cloning) }}
        </p>
        <div class="flex flex-wrap items-end gap-2">
          <label class="space-y-1 text-xs font-medium"
            ><span>{{ maxSamplesOf(cloning) === 1 ? "Sample" : "Samples" }}</span
            ><input
              type="file"
              :accept="acceptOf(cloning)"
              :multiple="maxSamplesOf(cloning) > 1"
              class="block text-xs"
              @change="pickKept"
          /></label>
          <span v-if="keep.samples.length" class="text-[11px] text-zinc-500">
            {{ plural(keep.samples.length, "sample") }},
            {{ sizeLabel(keep.samples.reduce((n, f) => n + f.size, 0)) }}
          </span>
          <span v-if="keep.leftOut" class="text-[11px] text-amber-600 dark:text-amber-400">
            {{ leftOutSaid(keep.leftOut, cloning) }}
          </span>
        </div>
        <p
          v-if="keepProblem"
          class="rounded bg-amber-400/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300"
          role="alert"
        >
          <WarnIcon class="icon-sm" /> {{ keepProblem }}
        </p>
        <label class="flex items-start gap-2 text-xs">
          <UiCheckbox v-model="keep.consent" />
          <span>{{ CLONE_CONSENT }}</span>
        </label>
        <div class="flex items-center gap-2">
          <button class="btn-primary btn-xs" type="submit" :disabled="keepBlocked">
            <KeptIcon class="icon-sm" /> {{ keep.busy ? "Keeping…" : "Keep samples" }}
          </button>
          <button class="btn-ghost btn-xs" type="button" @click="keep.voiceId = null">
            Cancel
          </button>
        </div>
      </form>

      <p class="mt-2 text-[11px] leading-relaxed text-zinc-500">
        Labels and gender are yours to change and take effect at once — the id is what goes in the
        request, so renaming a voice re-routes nothing. Removing one leaves the speakers that used
        it unrouted in every book, and is undoable from the toast; any samples kept for it are held
        for a day in case it comes back, then go.
      </p>
    </section>
  </div>
</template>
