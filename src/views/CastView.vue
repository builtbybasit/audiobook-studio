<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";

// Book-wide cast, and the one place every field of a speaker can be edited.
//
// A speaker used to be edited in three places and never completely: merge and rename here, voice
// and delivery style on the Narration voice cards, voice and rename again in the reader's rail —
// while gender, description and main/minor could not be changed anywhere at all, even though
// auto-assign routes by gender and the cards show "unknown". The table below is still the
// overview; expanding a row opens the full record, so there is one answer to "where do I change
// this" and the other two surfaces stay the quick paths they always were.
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";

import { useBookId } from "@/composables/useBookId";
import { UiSelect, UiCombobox, UiCheckbox, UiSwitch, UiTooltip } from "@/ui";
import VoicePicker from "@/components/VoicePicker.vue";
import {
  ChevronDown as OpenIcon,
  ChevronRight as ClosedIcon,
  Plus as AddIcon,
  X as CloseIcon,
} from "@lucide/vue";
import type { Character, Gender } from "@/types";
const castOpts = computed(() =>
  cast.value.map((c) => ({
    value: c.name,
    label: c.name,
    color: c.color,
    keywords: c.aliases.join(" "),
  })),
);

const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const libraryStore = useLibraryStore();
const voiceOpts = computed(() => endpointsStore.voiceOptions);
const bookId = useBookId();
const cast = computed(() => castStore.charactersOf(bookId));
const stats = computed(() => castStore.castStats(bookId));
const suggestions = computed(() => castStore.mergeSuggestions(bookId));
const q = ref("");
const sort = ref("lines");
const onlyNew = ref(false);
const sel = ref(new Set<string>());
const editing = ref<string | null>(null);
const draft = ref("");
const total = computed(() => libraryStore.chaptersOf(bookId).length);

const rows = computed(() =>
  cast.value
    .filter(
      (c) =>
        !q.value ||
        c.name.toLowerCase().includes(q.value.toLowerCase()) ||
        c.aliases.some((a) => a.toLowerCase().includes(q.value.toLowerCase())),
    )
    .filter((c) => !onlyNew.value || c.isNew)
    .map((c) => ({
      c,
      st: stats.value[c.name] ?? { lines: 0, chapters: new Set<number>(), first: 0 },
    }))
    .sort((a, b) =>
      sort.value === "lines"
        ? b.st.lines - a.st.lines
        : sort.value === "first"
          ? (a.st.first ?? 999) - (b.st.first ?? 999)
          : a.c.name.localeCompare(b.c.name),
    ),
);

function toggle(name: string) {
  const s = new Set(sel.value);
  if (s.has(name)) s.delete(name);
  else s.add(name);
  sel.value = s;
}
function mergeSelectedInto(into: string | number | null) {
  castStore.mergeMany(bookId, [...sel.value], String(into));
  sel.value = new Set();
}
const pickers = ref<Record<string, { open: boolean } | null>>({});
function onRowKey(e: KeyboardEvent, c: Character) {
  const t = e.target as HTMLElement;
  if (["INPUT", "TEXTAREA"].includes(t.tagName) || t.closest("[role=dialog],[role=listbox]"))
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
    const pk = pickers.value[c.name];
    if (pk) pk.open = true;
  } else if (e.key === "Enter") {
    e.preventDefault();
    startRename(c);
  } else if (e.key === "x" && c.name !== "Narrator") {
    e.preventDefault();
    toggle(c.name);
  }
}
function startRename(c: Character) {
  editing.value = c.name;
  draft.value = c.name;
}
/** Dismiss a merge suggestion: the name stays as its own character. */
function keepSuggestion(name: string) {
  const c = castStore.characters[bookId]?.find((x) => x.name === name);
  if (!c) return;
  c.isNew = false;
  c.keep = true;
}
function commit() {
  if (editing.value) castStore.renameCharacter(bookId, editing.value, draft.value);
  editing.value = null;
}
const genderLabel = { m: "male", f: "female", n: "neutral", "?": "unknown" };
const GENDERS: { value: Gender; label: string }[] = [
  { value: "f", label: "female" },
  { value: "m", label: "male" },
  { value: "n", label: "neutral" },
  { value: "?", label: "unknown" },
];

// ---------- the full record ----------
// One row at a time: the detail is wide, and two open at once is a diff nobody asked for.
const open = ref<string | null>(null);
const toggleOpen = (name: string) => (open.value = open.value === name ? null : name);

/** Gender is not cosmetic — `autoAssignByGender` pools voices by it, so an unknown is a speaker
 *  auto-assign has to skip. Worth saying next to the field rather than in a tooltip nobody opens. */
const unknownGender = computed(() => cast.value.filter((c) => c.gender === "?").length);

const alias = ref("");
function addAlias(c: Character) {
  if (castStore.addAlias(bookId, c.name, alias.value)) alias.value = "";
}

/** A row's position is not final until the page has laid out and painted: on first mount the table
 *  is already in the document but the scrolling container is not settled, and scrolling then lands
 *  a few pixels down a page that is about to grow. One frame later it is right. */
const afterPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** Bring one speaker's row into view and open it. Used both by `?speaker=` and after adding one. */
async function reveal(name: string) {
  open.value = name;
  await nextTick();
  await afterPaint();
  document
    .querySelector(`[data-speaker="${CSS.escape(name)}"]`)
    ?.scrollIntoView({ block: "center", behavior: "smooth" });
}

// `?speaker=` — the Narration voice cards send you here to edit one speaker, so land on their
// record rather than at the top of a list of twenty-two names. Any filter is cleared first, or the
// row the link promised could be filtered out of the page it arrives on.
const route = useRoute();
function revealFromQuery() {
  const name = route.query.speaker;
  if (typeof name !== "string" || !cast.value.some((c) => c.name === name)) return;
  q.value = "";
  onlyNew.value = false;
  void reveal(name);
}
// On mount rather than an immediate watcher: a watcher fires during setup, and the row it wants to
// scroll to is not in the document yet, so the record opened and the page stayed at the top.
onMounted(revealFromQuery);
watch(() => route.query.speaker, revealFromQuery);

// `?only=new` — the review inbox sends you here to work through the speakers a re-script brought
// in, so the page arrives narrowed to them rather than showing all twenty-two names. Setting a ref
// touches no DOM, so this one can fire during setup.
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
  // A speaker added by hand has no lines, so the default "most lines" order files them at the
  // bottom — opening their record without bringing it into view is opening it nowhere.
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
          {{ cast.length }} speakers across {{ total }} chapters ·
          {{ cast.filter((c) => c.isNew).length }} unreviewed ·
          {{ cast.filter((c) => c.voice).length }} voiced ·
          <UiTooltip
            text="Auto-assign pools voices by gender, so it skips a speaker whose gender is unknown. Open a row to set it."
            ><span
              v-if="unknownGender"
              class="cursor-help underline decoration-dotted underline-offset-2"
              >{{ unknownGender }} unknown gender</span
            ></UiTooltip
          >
          <span v-if="unknownGender">·</span>
          <kbd
            class="rounded border border-zinc-200 px-1 font-mono text-[10px] dark:border-zinc-700"
            >j</kbd
          >/<kbd
            class="rounded border border-zinc-200 px-1 font-mono text-[10px] dark:border-zinc-700"
            >k</kbd
          >
          <kbd
            class="rounded border border-zinc-200 px-1 font-mono text-[10px] dark:border-zinc-700"
            >v</kbd
          >
          voice
          <kbd
            class="rounded border border-zinc-200 px-1 font-mono text-[10px] dark:border-zinc-700"
            >x</kbd
          >
          tick
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
          @click="suggestions.forEach((s) => castStore.mergeCharacter(bookId, s.from, s.into))"
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
          :style="{ background: (cast.find((c) => c.name === s.from)?.color ?? '#999') + '33' }"
          >{{ s.from }}</span
        >
        <span class="text-zinc-400">→</span>
        <span
          class="rounded-full px-2 py-0.5 text-xs"
          :style="{ background: (cast.find((c) => c.name === s.into)?.color ?? '#999') + '33' }"
          >{{ s.into }}</span
        >
        <span class="min-w-0 flex-1 truncate text-xs text-zinc-500"
          >{{ s.reason }} · {{ stats[s.from]?.lines ?? 0 }} lines would move</span
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

    <div
      v-if="sel.size"
      class="flex items-center gap-2 rounded-lg border border-violet-300 bg-violet-50 px-4 py-2 text-sm dark:border-violet-500/40 dark:bg-violet-500/10"
    >
      <b>{{ sel.size }} selected</b> → merge into
      <UiCombobox
        action
        :options="castOpts.filter((o) => !sel.has(o.value))"
        placeholder="choose a speaker…"
        size="xs"
        class="w-56"
        @pick="mergeSelectedInto"
      />
      <button class="ml-auto text-xs text-zinc-500" @click="sel = new Set()">clear</button>
    </div>

    <div class="card overflow-x-auto">
      <table class="w-full min-w-[760px] text-sm">
        <thead
          class="bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900"
        >
          <tr>
            <th class="w-8 px-3 py-2"></th>
            <th>Speaker</th>
            <th class="w-20">Gender</th>
            <th class="w-16 pr-4 text-right">Lines</th>
            <th class="w-44 pl-2">Chapters</th>
            <th class="w-52">Voice</th>
            <th class="w-24"></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="{ c, st } in rows" :key="c.name">
            <tr
              data-row
              :data-speaker="c.name"
              tabindex="0"
              class="border-t border-zinc-100 outline-none focus-visible:bg-zinc-100 dark:border-zinc-800/70 dark:focus-visible:bg-zinc-800"
              :class="c.isNew && 'bg-amber-400/5'"
              @keydown="onRowKey($event, c)"
            >
              <td class="px-3">
                <UiCheckbox
                  v-if="c.name !== 'Narrator'"
                  :model-value="sel.has(c.name)"
                  @update:model-value="toggle(c.name)"
                />
              </td>
              <td class="py-2">
                <div class="flex items-center gap-2">
                  <button
                    class="-ml-1 shrink-0 rounded p-0.5 text-zinc-400 hover:text-violet-500"
                    :aria-expanded="open === c.name"
                    :aria-label="`${open === c.name ? 'Close' : 'Open'} the full record for ${c.name}`"
                    @click="toggleOpen(c.name)"
                  >
                    <component :is="open === c.name ? OpenIcon : ClosedIcon" class="icon-sm" />
                  </button>
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
                  <span
                    v-if="c.isNew"
                    class="rounded bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-600"
                    >new</span
                  >
                  <span
                    v-if="!c.major && !c.isNew"
                    class="rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-zinc-800"
                    >minor</span
                  >
                </div>
                <div class="pl-4.5 text-[11px] text-zinc-500">
                  <span v-if="c.aliases.length">a.k.a. {{ c.aliases.join(", ") }}</span
                  ><span v-if="c.description" class="ml-1 italic opacity-70"
                    >· {{ c.description.slice(0, 70)
                    }}{{ c.description.length > 70 ? "…" : "" }}</span
                  >
                </div>
              </td>
              <td class="text-xs">
                <button
                  class="rounded px-1 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  :class="c.gender === '?' ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-500'"
                  :title="`Set ${c.name}’s gender`"
                  @click="toggleOpen(c.name)"
                >
                  {{ genderLabel[c.gender] ?? "unknown" }}
                </button>
              </td>
              <td class="pr-4 text-right font-mono text-xs">{{ st.lines }}</td>
              <td class="pl-2">
                <div
                  class="flex h-3 gap-px"
                  :title="`in ${st.chapters.size} chapters, first in ch ${st.first ?? '—'}`"
                >
                  <span
                    v-for="i in total"
                    :key="i"
                    class="flex-1 rounded-sm"
                    :class="st.chapters.has(i) ? 'bg-violet-500' : 'bg-zinc-200 dark:bg-zinc-800'"
                  ></span>
                </div>
                <div class="text-[10px] text-zinc-400">
                  {{ st.chapters.size }} ch · first ch {{ st.first ?? "—" }}
                </div>
              </td>
              <td class="py-1 pr-2">
                <VoicePicker
                  :ref="(el) => (pickers[c.name] = el as { open: boolean } | null)"
                  v-model="c.voice"
                  :book-id="bookId"
                  :speaker="c.name"
                  size="xs"
                  block
                />
              </td>
              <td class="pr-3 text-right">
                <button class="text-xs text-zinc-400 hover:text-violet-500" @click="startRename(c)">
                  rename
                </button>
                <button
                  v-if="c.name !== 'Narrator'"
                  class="ml-2 text-xs text-zinc-400 hover:text-red-500"
                  @click="castStore.deleteCharacter(bookId, c.name)"
                  title="Merge into Narrator"
                >
                  <CloseIcon class="icon-sm" />
                </button>
              </td>
            </tr>
            <!-- the full record: every field a speaker has, in the one place that has them all -->
            <tr v-if="open === c.name" class="bg-zinc-50/70 dark:bg-zinc-900/60">
              <td></td>
              <td colspan="6" class="px-1 py-3 pr-4">
                <div class="grid gap-4 lg:grid-cols-2">
                  <div class="space-y-2.5">
                    <label class="block space-y-1 text-xs font-medium"
                      ><span>Name</span
                      ><input
                        :value="c.name"
                        class="input w-full"
                        @change="
                          castStore.renameCharacter(
                            bookId,
                            c.name,
                            ($event.target as HTMLInputElement).value,
                          )
                        "
                      />
                      <span class="block text-[11px] font-normal text-zinc-500"
                        >Renaming re-points every line. Typing an existing speaker’s name merges
                        into them.</span
                      ></label
                    >
                    <div class="flex flex-wrap items-end gap-3">
                      <label class="space-y-1 text-xs font-medium"
                        ><span>Gender</span>
                        <UiSelect
                          :model-value="c.gender"
                          :options="GENDERS"
                          size="xs"
                          class="w-32"
                          :aria-label="`Gender for ${c.name}`"
                          @update:model-value="
                            (g) =>
                              castStore.updateCharacter(bookId, c.name, { gender: g as Gender })
                          "
                      /></label>
                      <label class="flex items-center gap-2 pb-1 text-xs font-medium"
                        ><UiSwitch
                          :model-value="c.major"
                          @update:model-value="
                            (v) => castStore.updateCharacter(bookId, c.name, { major: v })
                          "
                        />
                        Main cast</label
                      >
                    </div>
                    <p class="text-[11px] leading-relaxed text-zinc-500">
                      Gender pools the voices auto-assign draws from — an unknown is skipped. Main
                      cast get their own card on the Narration stage; minor speakers are collapsed
                      there and read in the Narrator’s voice until given one.
                    </p>
                    <label class="block space-y-1 text-xs font-medium"
                      ><span>Voice</span>
                      <VoicePicker v-model="c.voice" :book-id="bookId" :speaker="c.name" block
                    /></label>
                    <label class="block space-y-1 text-xs font-medium"
                      ><span>Delivery style</span
                      ><input
                        :value="c.style"
                        class="input w-full"
                        placeholder="e.g. gravelly, elderly; speaks slowly"
                        @input="
                          castStore.updateCharacter(bookId, c.name, {
                            style: ($event.target as HTMLInputElement).value,
                          })
                        "
                      />
                      <span class="block text-[11px] font-normal text-zinc-500"
                        >A note carried with every line this speaker has.</span
                      ></label
                    >
                  </div>

                  <div class="space-y-2.5">
                    <label class="block space-y-1 text-xs font-medium"
                      ><span>Description</span
                      ><textarea
                        :value="c.description"
                        rows="4"
                        class="input w-full resize-y leading-relaxed"
                        placeholder="Who they are — kept out of the way on the Narration cards because it spoils."
                        @input="
                          castStore.updateCharacter(bookId, c.name, {
                            description: ($event.target as HTMLTextAreaElement).value,
                          })
                        "
                      ></textarea>
                    </label>
                    <div class="space-y-1 text-xs font-medium">
                      <span>Also called</span>
                      <div class="flex flex-wrap items-center gap-1">
                        <span
                          v-for="a in c.aliases"
                          :key="a"
                          class="inline-flex items-center gap-1 rounded-full border border-zinc-200 py-0.5 pl-2 pr-1 text-[11px] font-normal dark:border-zinc-700"
                          >{{ a }}
                          <button
                            class="rounded px-0.5 text-zinc-400 hover:text-red-500"
                            :aria-label="`Remove alias ${a}`"
                            @click="castStore.removeAlias(bookId, c.name, a)"
                          >
                            <CloseIcon class="icon-sm" />
                          </button>
                        </span>
                        <span v-if="!c.aliases.length" class="text-[11px] font-normal text-zinc-400"
                          >none</span
                        >
                      </div>
                      <form class="flex items-center gap-1 pt-1" @submit.prevent="addAlias(c)">
                        <input
                          v-model="alias"
                          class="input w-40 py-0.5"
                          placeholder="another name"
                          :aria-label="`Add an alias for ${c.name}`"
                        />
                        <button class="btn-ghost btn-xs" type="submit">
                          <AddIcon class="icon-sm" /> Add
                        </button>
                      </form>
                      <p class="text-[11px] font-normal leading-relaxed text-zinc-500">
                        Names the same speaker is called by, used when matching and searching. To
                        move another speaker’s lines here, tick them above and merge instead.
                      </p>
                    </div>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>
