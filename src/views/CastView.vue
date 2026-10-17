<script setup lang="ts">
import { newStat, useCastStore } from "@/stores/cast";
import { useEffectsStore } from "@/stores/effects";
import { plural } from "@/lib/contents";
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { useSpeakerSamplesStore } from "@/stores/speakerSamples";

// Book-wide cast, and the one place every field of a speaker can be edited.
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";

import { useBookId } from "@/composables/useBookId";
import { useBookScripts, useCast, useEffects } from "@/queries";
import { GENDER } from "@/lib/scriptReview";
import { applySpan, useRangeSelect } from "@/composables/useRangeSelect";
import { UiSelect, UiCheckbox, UiHint, UiNumber, UiTooltip } from "@/ui";
import VoicePicker from "@/components/VoicePicker.vue";
import SpoilerText from "@/components/SpoilerText.vue";
import ReadFailure, { scriptsUnread } from "@/components/ReadFailure.vue";
import { Cloud as ThoughtIcon, Plus as AddIcon, VenetianMask as MaskIcon } from "@lucide/vue";
import CastRecord from "@/views/cast/CastRecord.vue";
import CastSelectionBar from "@/views/cast/CastSelectionBar.vue";
import BookDefaults from "@/views/cast/BookDefaults.vue";
import EffectsSheet from "@/views/cast/effects/EffectsSheet.vue";
import ReapplyBar from "@/views/cast/effects/ReapplyBar.vue";
import type { EffectSubject } from "@/views/cast/effects/subject";
import { nestPersonas } from "@/views/cast/persona/rows";
import { personaOwner, voiced as isVoiced } from "@/lib/cast";
import { SPEAKER_SPEED, speedSplit } from "@/lib/providers";
import type { Character, Gender } from "@/types";

const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const libraryStore = useLibraryStore();
const samplesStore = useSpeakerSamplesStore();
const effectsStore = useEffectsStore();
const bookId = useBookId();
const { characters: cast } = useCast(bookId);
// line counts are not counts at all until every scripted chapter is in
const { failed: unread, loading: reading, retry: readAgain } = useBookScripts(bookId);
const counted = computed(() => !reading.value && !unread.value.length);
const stats = computed(() => castStore.castStats(bookId));
const suggestions = computed(() => castStore.mergeSuggestions(bookId));
const q = ref("");
const sort = ref("lines");
const onlyNew = ref(false);
const sel = ref(new Set<string>());
const editing = ref<string | null>(null);
const draft = ref("");
const total = computed(() => libraryStore.chaptersOf(bookId).length);
const unreviewed = computed(() => cast.value.filter((c) => c.isNew).length);
// a linked persona with no voice of their own is read in their character's (`voiced`)
const voiced = computed(() => {
  const byName = castStore.byName[bookId] ?? new Map<string, Character>();
  return cast.value.filter((c) => isVoiced(c, byName)).length;
});
const colorOf = computed(() => new Map(cast.value.map((c) => [c.name, c.color])));

// A linked persona's row sits under its character's, whatever the order (`nestPersonas`) — unless
// the scripting model made the link, which stays a spoiler.
const rows = computed(() => {
  const needle = q.value.toLowerCase();
  const byName = castStore.byName[bookId] ?? new Map<string, Character>();
  const sorted = cast.value
    .filter(
      (c) =>
        !needle ||
        c.name.toLowerCase().includes(needle) ||
        c.aliases.some((a) => a.toLowerCase().includes(needle)),
    )
    .filter((c) => !onlyNew.value || c.isNew)
    .map((c) => {
      const of = personaOwner(c, byName)?.name;
      return {
        c,
        of,
        st: stats.value[c.name] ?? newStat(),
        voice: endpointsStore.resolveVoice(c.voice),
        borrowed: c.voice ? null : castStore.effectiveVoice(bookId, c.name),
        speedMade: c.speed ? speedTitle(c.name, c.speed) : undefined,
      };
    })
    .sort((a, b) =>
      sort.value === "lines"
        ? b.st.lines - a.st.lines
        : sort.value === "first"
          ? a.st.first - b.st.first
          : a.c.name.localeCompare(b.c.name),
    );
  return nestPersonas(sorted, byName);
});
/** A row's speed tooltip: who makes it, so whether a change costs a re-narration. No endpoint
 *  name: a masked persona's would point at their wearer. */
const speedTitle = (name: string, speed: number): string =>
  speedSplit(castStore.effectiveVoice(bookId, name).endpoint, speed).sent
    ? "Sent to the voice’s service"
    : "Made here after the voice speaks";
/** A speaker's line count for their record, or null while the book's scripts are not all read. */
const linesOf = (name: string) => (counted.value ? (stats.value[name]?.lines ?? 0) : null);

// the Narrator has no box, so no run includes them
const range = useRangeSelect(() =>
  rows.value.map((r) => r.c.name).filter((name) => name !== "Narrator"),
);
/** Tick or untick a row, or with shift the run from the last one. */
function tick(name: string, e?: MouseEvent) {
  sel.value = applySpan(sel.value, range.span(name, e), !sel.value.has(name));
}
// One voice picker serves every row (a reka popover per row was most of a long cast's components).
const voiceOpen = ref(false);
const voiceFor = ref<{ name: string; anchor: HTMLElement } | null>(null);
function showVoice(name: string, anchor: HTMLElement | null | undefined) {
  if (!anchor) return;
  voiceFor.value = { name, anchor };
  voiceOpen.value = true;
}
function voiceClick(name: string, e: MouseEvent) {
  if (voiceOpen.value && voiceFor.value?.name === name) voiceOpen.value = false;
  else showVoice(name, e.currentTarget as HTMLElement);
}
function onRowKey(e: KeyboardEvent, c: Character) {
  const t = e.target as HTMLElement;
  if (
    ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) ||
    t.closest("[role=dialog],[role=listbox]")
  )
    return;
  const row = e.currentTarget as HTMLElement;
  const list = [...(row.parentElement?.querySelectorAll<HTMLElement>("tr[data-row]") ?? [])];
  const i = list.indexOf(row);
  if (e.key === "ArrowDown" || e.key === "j") {
    e.preventDefault();
    list[i + 1]?.focus();
  } else if (e.key === "ArrowUp" || e.key === "k") {
    e.preventDefault();
    list[i - 1]?.focus();
  } else if (e.key === "v") {
    e.preventDefault();
    showVoice(c.name, row.querySelector<HTMLElement>("[data-voice-anchor]"));
  } else if (e.key === "Enter") {
    e.preventDefault();
    startRename(c);
  } else if (e.key === "x" && c.name !== "Narrator") {
    e.preventDefault();
    tick(c.name);
  }
}
function startRename(c: Character) {
  if (c.name === "Narrator") return; // the server refuses it, as it refuses removing them
  editing.value = c.name;
  draft.value = c.name;
}
function keepSuggestion(name: string) {
  void castStore.keepCharacter(bookId, name);
}
function commit() {
  if (editing.value) castStore.renameCharacter(bookId, editing.value, draft.value);
  editing.value = null;
}
// unknown reads as a quiet dash: it is most rows of a fresh cast
const GENDERS = (["f", "m", "n", "?"] as Gender[]).map((value) => ({
  value,
  label: GENDER[value] ?? "—",
}));
function setGender(name: string, e: Event) {
  const gender = (e.target as HTMLSelectElement).value as Gender;
  void castStore.updateCharacter(bookId, name, { gender });
}

useEffects();
const effectOf = (id: string | undefined) => (id ? effectsStore.byId.get(id) : undefined);
const sheetOpen = ref(false);
const sheetFor = ref<EffectSubject | null>(null);
function editEffect(subject: EffectSubject) {
  sheetFor.value = subject;
  sheetOpen.value = true;
}

// One open record at a time: the detail is wide.
const open = ref<string | null>(null);
const toggleOpen = (name: string) => (open.value = open.value === name ? null : name);

/** `autoAssignByGender` pools voices by gender, so an unknown is a speaker auto-assign skips. */
const unknownGender = computed(() => cast.value.filter((c) => c.gender === "?").length);

/** A row's position is not settled on first mount; scrolling then lands a few pixels off. One frame
 *  later it is right. */
const afterPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function reveal(name: string) {
  open.value = name;
  await nextTick();
  await afterPaint();
  document
    .querySelector(`[data-speaker="${CSS.escape(name)}"]`)
    ?.scrollIntoView({ block: "center", behavior: "smooth" });
}

// `?speaker=` lands on that speaker's record. Filters are cleared first, or the row could be
// filtered out of the page it arrives on.
const route = useRoute();
function revealFromQuery() {
  const name = route.query.speaker;
  if (typeof name !== "string" || !cast.value.some((c) => c.name === name)) return;
  q.value = "";
  onlyNew.value = false;
  void reveal(name);
}
// On mount, not an immediate watcher: during setup the row is not in the document yet.
onMounted(revealFromQuery);
watch(() => route.query.speaker, revealFromQuery);

// Voice samples a script file brought for a speaker whose voice this install cannot reach.
void samplesStore.load(bookId);
const waiting = (name: string) => {
  const w = samplesStore.waitingFor(bookId, name);
  return w ? [w] : [];
};

// `?only=new` narrows to the speakers a re-script brought in. Touches no DOM, so runs in setup.
watch(
  () => route.query.only,
  (v) => {
    if (v === "new") onlyNew.value = true;
  },
  { immediate: true },
);

const adding = ref(false);
const newName = ref("");
const newNameInput = ref<HTMLInputElement | null>(null);
async function startAdd() {
  adding.value = true;
  newName.value = "";
  await nextTick();
  newNameInput.value?.focus();
}
async function commitAdd() {
  const name = newName.value.trim();
  if (!name) {
    adding.value = false;
    return;
  }
  if (!castStore.addCharacter(bookId, name)) return;
  adding.value = false;
  newName.value = "";
  // a hand-added speaker has no lines, so "most lines" files them at the bottom
  await reveal(name);
}
const duplicate = computed(
  () => !!newName.value.trim() && cast.value.some((c) => c.name === newName.value.trim()),
);
</script>

<template>
  <div class="mx-auto max-w-6xl space-y-4 p-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Cast</h1>
        <p class="text-sm text-zinc-500">
          {{ cast.length }} speakers across {{ total }} chapters · {{ unreviewed }} unreviewed ·
          {{ voiced }} voiced<template v-if="unknownGender">
            ·
            <UiTooltip
              text="Auto-assign pools voices by gender, so it skips a speaker whose gender is unknown."
              ><span class="cursor-help underline decoration-dotted underline-offset-2"
                >{{ unknownGender }} unknown gender</span
              ></UiTooltip
            ></template
          >
          <UiHint
            class="ml-1"
            label="the keyboard"
            text="j/k move · v voice · x tick · shift-click a range · Enter rename"
          />
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <form v-if="adding" class="flex items-center gap-1" @submit.prevent="commitAdd">
          <input
            ref="newNameInput"
            v-model="newName"
            class="input w-40"
            placeholder="Speaker name"
            aria-label="New speaker name"
            @keydown.esc="adding = false"
          />
          <button class="btn-primary btn-xs" type="submit" :disabled="duplicate">Add</button>
          <button class="btn-ghost btn-xs" type="button" @click="adding = false">Cancel</button>
          <span v-if="duplicate" class="text-[11px] text-amber-600 dark:text-amber-400"
            >already in the cast</span
          >
        </form>
        <button v-else class="btn-ghost btn-xs" @click="startAdd">
          <AddIcon class="icon-sm" /> Add speaker
        </button>
        <input v-model="q" class="input w-48" placeholder="Find a speaker…" />
        <label class="flex items-center gap-1.5 text-xs"
          ><UiCheckbox v-model="onlyNew" /> unreviewed only</label
        >
        <UiSelect
          v-model="sort"
          :options="[
            { value: 'lines', label: 'Most lines' },
            { value: 'first', label: 'First appearance' },
            { value: 'name', label: 'Name' },
          ]"
        />
      </div>
    </div>

    <div v-if="suggestions.length" class="card border-violet-300 dark:border-violet-500/40">
      <div
        class="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800"
      >
        <span class="label">Merge suggestions</span
        ><span class="text-xs text-zinc-400">{{ suggestions.length }}</span>
        <button
          class="ml-auto text-xs text-violet-500 hover:underline"
          @click="castStore.mergeMany(bookId, suggestions)"
        >
          accept all
        </button>
      </div>
      <div
        v-for="s in suggestions"
        :key="s.from"
        class="flex items-center gap-3 border-b border-zinc-100 px-4 py-2 text-sm last:border-0 dark:border-zinc-800/70"
      >
        <span
          class="rounded-full px-2 py-0.5 text-xs"
          :style="{ background: (colorOf.get(s.from) ?? '#999') + '33' }"
          >{{ s.from }}</span
        >
        <span class="text-zinc-400">→</span>
        <span
          class="rounded-full px-2 py-0.5 text-xs"
          :style="{ background: (colorOf.get(s.into) ?? '#999') + '33' }"
          >{{ s.into }}</span
        >
        <span class="min-w-0 flex-1 truncate text-xs text-zinc-500"
          >{{ s.reason
          }}<template v-if="counted">
            · {{ plural(stats[s.from]?.lines ?? 0, "line") }} would move</template
          ></span
        >
        <button
          class="btn-primary btn-xs"
          @click="castStore.mergeCharacter(bookId, s.from, s.into)"
        >
          Merge
        </button>
        <button class="btn-ghost btn-xs" @click="keepSuggestion(s.from)">Keep separate</button>
      </div>
    </div>

    <ReadFailure
      v-if="unread.length"
      :message="`${scriptsUnread(unread.length)}, so the speakers’ line counts are not shown.`"
      @retry="readAgain"
    />

    <BookDefaults
      :book-id="bookId"
      :stats="stats"
      :counted="counted"
      @thoughts="editEffect({ kind: 'book' })"
      @tune="(id) => editEffect({ kind: 'book', effect: id })"
      @tune-line="(id) => editEffect({ kind: 'line', effect: id })"
    />
    <ReapplyBar :book-id="bookId" />

    <div class="card overflow-x-auto">
      <table class="w-full min-w-[800px] text-sm">
        <thead
          class="bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900"
        >
          <tr>
            <th class="w-8 px-3 py-2"></th>
            <th>Speaker</th>
            <th class="w-20">Gender</th>
            <th class="w-16 pr-4 text-right">Lines</th>
            <th class="w-52">Voice</th>
            <th class="w-44 pl-2">Effect</th>
            <th class="w-24">
              Speed
              <UiHint
                label="speed"
                text="Sent to the voice’s service when it takes that speed, so changing it means re-narrating. Otherwise the speed is made here after the voice speaks, and a change is re-applied for free."
              />
            </th>
            <th class="w-10"></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="{ c, st, voice, borrowed, speedMade, of, nested } in rows" :key="c.name">
            <tr
              data-row
              :data-speaker="c.name"
              tabindex="0"
              class="border-t border-zinc-100 outline-none focus-visible:bg-zinc-100 dark:border-zinc-800/70 dark:focus-visible:bg-zinc-800"
              :class="nested && 'bg-zinc-50/50 dark:bg-zinc-900/30'"
              @keydown="onRowKey($event, c)"
            >
              <td class="px-3">
                <UiCheckbox
                  v-if="c.name !== 'Narrator'"
                  :model-value="sel.has(c.name)"
                  :aria-label="`Select ${c.name}`"
                  @click="tick(c.name, $event)"
                />
              </td>
              <td class="py-2">
                <div class="flex items-center gap-2" :class="nested && 'pl-5'">
                  <button
                    class="-ml-1 shrink-0 rounded p-0.5 text-zinc-400 hover:text-violet-500"
                    :aria-expanded="open === c.name"
                    :aria-label="`${open === c.name ? 'Close' : 'Open'} the full record for ${c.name}`"
                    @click="toggleOpen(c.name)"
                  >
                    <!-- plain markup: an icon component is two instances, three per row -->
                    <svg
                      :class="['icon-sm', open === c.name && 'rotate-90']"
                      xmlns="http://www.w3.org/2000/svg"
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </button>
                  <span
                    v-if="nested"
                    class="-ml-1 text-zinc-300 dark:text-zinc-600"
                    aria-hidden="true"
                    >↳</span
                  >
                  <span
                    class="h-2.5 w-2.5 shrink-0 rounded-full"
                    :style="{ background: c.color }"
                  ></span>
                  <input
                    v-if="editing === c.name"
                    v-model="draft"
                    class="input py-0"
                    autofocus
                    @keydown.enter="commit"
                    @keydown.esc="editing = null"
                    @blur="commit"
                  />
                  <b v-else class="cursor-text" @dblclick="startRename(c)">{{ c.name }}</b>
                  <!-- a link the scripting model made says whose only when asked: a spoiler -->
                  <span
                    v-if="of || c.masked"
                    class="inline-flex items-center gap-0.5 rounded bg-violet-500/10 px-1 text-[10px] text-violet-600 dark:text-violet-300"
                    ><MaskIcon class="h-3 w-3" aria-hidden="true" /><template v-if="!of"
                      >masked · identity unknown</template
                    ><template v-else
                      >persona of
                      <SpoilerText :text="of" :hidden="!!c.masked" label="hidden · show" small
                    /></template>
                  </span>
                  <span
                    v-if="c.isNew"
                    class="rounded bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-600"
                    >new</span
                  >
                  <span
                    v-if="waiting(c.name).length"
                    class="rounded bg-violet-500/15 px-1 text-[10px] font-semibold text-violet-600 dark:text-violet-300"
                    title="Voice samples from an imported script are waiting — open the speaker to clone or discard them"
                    >samples</span
                  >
                  <span
                    v-if="!c.major && !c.isNew"
                    class="rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-zinc-800"
                    >minor</span
                  >
                </div>
                <!-- no description here: it is written from the whole book, and would spoil it -->
                <div
                  v-if="c.aliases.length"
                  class="text-[11px] text-zinc-500"
                  :class="nested ? 'pl-10' : 'pl-4.5'"
                >
                  a.k.a. {{ c.aliases.join(", ") }}
                </div>
              </td>
              <td class="text-xs">
                <!-- a native select: a reka one per row is heavy at three hundred speakers -->
                <select
                  :value="c.gender"
                  :aria-label="`${c.name}’s gender`"
                  class="-ml-1 cursor-pointer appearance-none rounded bg-transparent px-1 py-0.5 scheme-light hover:bg-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:scheme-dark dark:hover:bg-zinc-800"
                  :class="
                    c.gender === '?'
                      ? 'text-zinc-400 dark:text-zinc-500'
                      : 'text-zinc-600 dark:text-zinc-300'
                  "
                  @change="setGender(c.name, $event)"
                >
                  <option v-for="g in GENDERS" :key="g.value" :value="g.value">
                    {{ g.label }}
                  </option>
                </select>
              </td>
              <!-- how many chapters, never which: where a speaker turns up is a spoiler -->
              <td class="pr-4 text-right font-mono text-xs">
                {{ counted ? st.lines : "…" }}
                <div v-if="counted" class="text-[10px] text-zinc-400">
                  {{ st.chapters.size }} ch
                </div>
              </td>
              <td class="py-1 pr-2">
                <!-- VoicePicker's trigger, drawn as a plain button that opens the shared picker -->
                <button
                  type="button"
                  data-voice-anchor
                  aria-haspopup="dialog"
                  :aria-expanded="voiceOpen && voiceFor?.name === c.name"
                  :data-state="voiceOpen && voiceFor?.name === c.name ? 'open' : 'closed'"
                  class="ui-select-trigger w-full py-0.5 text-xs"
                  :class="[
                    !c.voice && 'italic text-zinc-400',
                    c.voice && !voice && 'ring-1 ring-amber-400',
                  ]"
                  @click="voiceClick(c.name, $event)"
                >
                  <span class="min-w-0 flex-1 truncate text-left">
                    <!-- the voice a masked link borrows would name its wearer as surely -->
                    <template v-if="!c.voice"
                      >{{ castStore.fallbackLabel(bookId, c.name)
                      }}<span
                        v-if="borrowed?.label && !(c.masked && of)"
                        class="text-zinc-300 dark:text-zinc-600"
                      >
                        · {{ borrowed?.label }}</span
                      ></template
                    >
                    <template v-else-if="voice"
                      >{{ voice.voice.label }}
                      <span class="text-zinc-400">· {{ voice.endpoint.name }}</span></template
                    >
                    <span v-else class="not-italic text-amber-600"
                      >{{ c.voice.split("/")[1] }} — missing</span
                    >
                  </span>
                  <svg
                    class="ml-1 icon-sm text-zinc-400"
                    xmlns="http://www.w3.org/2000/svg"
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
              </td>
              <td class="py-1 pl-2">
                <!-- thought effect only when their own: the book's default would mark every row -->
                <div class="flex items-center gap-1">
                  <button
                    type="button"
                    class="chip min-w-0 max-w-[7.5rem]"
                    :class="effectOf(c.effect) ? 'chip-on' : 'chip-off'"
                    :aria-label="`${c.name}’s effect`"
                    :title="of && !c.masked ? `Worn after ${of}’s effect` : undefined"
                    @click="editEffect({ kind: 'speaker', name: c.name, slot: 'effect' })"
                  >
                    <span class="truncate">{{ effectOf(c.effect)?.name ?? "None" }}</span>
                  </button>
                  <button
                    v-if="c.thoughts != null"
                    type="button"
                    class="chip chip-on min-w-0 max-w-[6.5rem]"
                    :aria-label="`${c.name}’s own thought effect`"
                    title="Their own thought effect"
                    @click="editEffect({ kind: 'speaker', name: c.name, slot: 'thoughts' })"
                  >
                    <ThoughtIcon class="icon-sm shrink-0" aria-hidden="true" /><span
                      class="truncate"
                      >{{ effectOf(c.thoughts)?.name ?? "None" }}</span
                    >
                  </button>
                </div>
              </td>
              <td class="py-1" :title="speedMade">
                <UiNumber
                  class="w-20"
                  :model-value="c.speed ?? 1"
                  :min="SPEAKER_SPEED.min"
                  :max="SPEAKER_SPEED.max"
                  :step="0.01"
                  :empty="1"
                  unit="×"
                  :label="`Speed for ${c.name}`"
                  @update:model-value="(v) => castStore.setSpeed(bookId, c.name, v)"
                />
              </td>
              <td class="pr-3 text-right">
                <button
                  v-if="c.name !== 'Narrator'"
                  class="text-xs text-zinc-400 hover:text-red-500"
                  @click="castStore.deleteCharacter(bookId, c.name)"
                  title="Remove — their lines go to the Narrator"
                  :aria-label="`Remove ${c.name}`"
                >
                  <svg
                    class="icon-sm"
                    xmlns="http://www.w3.org/2000/svg"
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              </td>
            </tr>
            <tr v-if="open === c.name" class="bg-zinc-50/70 dark:bg-zinc-900/60">
              <td></td>
              <td colspan="7" class="px-1 py-3 pr-4">
                <CastRecord :book-id="bookId" :c="c" :lines="linesOf" />
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <VoicePicker
        v-model:open="voiceOpen"
        :anchor="voiceFor?.anchor ?? null"
        :model-value="cast.find((c) => c.name === voiceFor?.name)?.voice ?? null"
        :book-id="bookId"
        :speaker="voiceFor?.name"
        @update:model-value="(v) => voiceFor && castStore.setVoice(bookId, voiceFor.name, v)"
      />
    </div>
    <EffectsSheet v-model:open="sheetOpen" :book-id="bookId" :subject="sheetFor" />
    <CastSelectionBar v-if="sel.size" :book-id="bookId" :selected="sel" @clear="sel = new Set()" />
  </div>
</template>
