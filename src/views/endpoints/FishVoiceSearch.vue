<script setup lang="ts">
import { useEndpointsStore } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";

// Searching Fish Audio's public catalogue, on a Fish endpoint's Voices tab.
//
// Fish Audio's public voices, a page at a time, through the server — which asks with the saved key.
// A result is only a result until "Add" puts it on this endpoint, and the write-behind saves it like
// any other voice.
import { computed, reactive } from "vue";
import { keyInPlace, type VoiceListPage } from "@/services/endpointSettings";
import { ApiError } from "@/services/http";
import { useVoiceSample } from "@/composables/useVoiceSample";
import { plural } from "@/lib/contents";
import {
  Check as AddedIcon,
  ChevronLeft as PrevIcon,
  ChevronRight as NextIcon,
  Globe as PublicIcon,
  LoaderCircle as BusyIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Plus as AddIcon,
  Search as SearchIcon,
} from "@lucide/vue";
import { UiHint, UiSelect } from "@/ui";
import { GENDER_ICON } from "@/views/endpoints/genders";
import type { Endpoint, FoundVoice, Voice } from "@/types";

const props = defineProps<{ endpoint: Endpoint }>();
const endpointsStore = useEndpointsStore();
const uiStore = useUiStore();
/** the sample being fetched, if any — one at a time */
const { loading: sampling, play, playUrl, playingId } = useVoiceSample();

const needsKeyFirst = computed(() => props.endpoint.needsKey && !keyInPlace(props.endpoint));

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

// A public voice found by the search plays Fish's own recording of it: a file on Fish's CDN, free,
// nothing rendered. One that has none is rendered by this endpoint like a listed voice. Either way
// it plays under an id of its own, apart from the listed voice's sample it may later become.
const foundId = (v: FoundVoice) => `found:${props.endpoint.id}/${v.id}`;
const foundTitle = (v: FoundVoice) => {
  if (!v.sample)
    return "Fish has no sample of this voice — hear it from this endpoint: a real request, billed once and replayed after";
  const said = v.sample.text.length > 120 ? `${v.sample.text.slice(0, 119)}…` : v.sample.text;
  return `Fish's own sample${said ? `: “${said}”` : ""} — free, nothing is rendered`;
};
async function playFound(v: FoundVoice) {
  try {
    if (v.sample) await playUrl(foundId(v), v.sample.url, v.label);
    else await play(props.endpoint, v.id, v.label, foundId(v));
  } catch (e) {
    uiStore.toast(`Could not play the sample of ${v.label}`, {
      kind: "error",
      description: e instanceof Error ? e.message : undefined,
    });
  }
}
</script>

<template>
  <section class="card p-3">
    <h3 class="label mb-2">
      <PublicIcon class="icon-sm" /> Public voices
      <UiHint
        label="public voices"
        text="Search Fish Audio’s public catalogue by title, or paste a voice’s id; adding one puts it on this endpoint’s list, best rated first."
      />
    </h3>
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
            :aria-label="`${playingId(foundId(v)) ? 'Pause' : 'Preview'} ${v.label}`"
            :title="foundTitle(v)"
            :disabled="!!sampling && sampling !== foundId(v)"
            :aria-busy="sampling === foundId(v)"
            @click="playFound(v)"
          >
            <BusyIcon v-if="sampling === foundId(v)" class="icon-sm animate-spin" />
            <PauseIcon v-else-if="playingId(foundId(v))" class="icon-sm icon-fill" />
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
          >Page {{ search.result.page }} ·
          {{ plural(search.result.total, "match", "matches") }}</span
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
</template>
