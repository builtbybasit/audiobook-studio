<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
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
// list endpoint at all.
import { computed, reactive, ref } from "vue";
import { keyring } from "@/lib/keyring";
import { speak } from "@/composables/usePlayer";
import type { Component } from "vue";
import {
  Dot as NeutralIcon,
  Mars as MaleIcon,
  Play as PlayIcon,
  Plus as AddIcon,
  RefreshCw as FetchIcon,
  Search as SearchIcon,
  TriangleAlert as WarnIcon,
  Venus as FemaleIcon,
  X as RemoveIcon,
} from "@lucide/vue";
import { UiSelect, UiTooltip } from "@/ui";
import { isFishAudio } from "@/lib/endpoints";
import type { Endpoint, Gender, Voice } from "@/types";

const props = defineProps<{ endpoint: Endpoint }>();
const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const libraryStore = useLibraryStore();

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
const needsKeyFirst = computed(() => props.endpoint.needsKey && !keyring.has(props.endpoint.id));
const fetchBlocked = computed(() => fish.value && needsKeyFirst.value);

const SAMPLE = "The mountain mist thinned as dawn crept over the outer sect grounds.";
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
            >Fish Audio quotes a voice as a <code class="font-mono">reference_id</code> from your
            own library, not a named voice.</template
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
          <button
            class="btn-ghost btn-xs shrink-0"
            :aria-label="`Preview ${v.label}`"
            title="preview with the browser’s own voice — the provider is never called"
            @click="speak(SAMPLE, v.id)"
          >
            <PlayIcon class="icon-sm icon-fill" />
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

      <p class="mt-2 text-[11px] leading-relaxed text-zinc-500">
        Labels and gender are yours to change and take effect at once — the id is what goes in the
        request, so renaming a voice re-routes nothing. Removing one leaves the speakers that used
        it unrouted in every book, and is undoable from the toast.
      </p>
    </section>
  </div>
</template>
