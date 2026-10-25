<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";

// How this book is *said*: the pronunciation dictionary and the pacing defaults. Neither edits the
// book, but a respelling or a pause inside a line needs the line rendered again; a pause between
// lines does not.
import { computed, nextTick, ref } from "vue";

import { UiCheckbox, UiHint, UiNumber, UiSwitch } from "@/ui";
import { hitsIn, marks, speak, DEFAULT_PACING, secs } from "@/lib/speech";
import { plural } from "@/lib/contents";
import {
  Plus as AddIcon,
  RotateCcw as RetryIcon,
  Trash2 as RemoveIcon,
  TriangleAlert as WarnIcon,
} from "@lucide/vue";
import type { LexEntry } from "@/types";
const props = defineProps<{ bookId: string }>();
const castStore = useCastStore();
const libraryStore = useLibraryStore();
const narrationStore = useNarrationStore();
const list = computed(() => castStore.lexiconOf(props.bookId));
const uses = computed(() => castStore.lexUses(props.bookId));
const pacing = computed(() => castStore.pacingOf(props.bookId));
const book = computed(() => libraryStore.bookById(props.bookId));
const open = ref<number | null>(null);
const term = ref("");
const say = ref("");
const termBox = ref<HTMLInputElement | null>(null);
const rows = ref<HTMLElement | null>(null);
// shared by the add form and every row, so the fields line up
const GRID =
  "grid grid-cols-[minmax(0,1fr)_0.75rem_minmax(0,1fr)_2.75rem_1.75rem_1.25rem] items-center gap-1.5";
const unused = computed(() => list.value.filter((e) => !uses.value[e.id]).length);

function add() {
  if (!term.value.trim() || !say.value.trim()) return;
  open.value = castStore.addTerm(props.bookId, term.value, say.value);
  term.value = "";
  say.value = "";
  nextTick(() => {
    termBox.value?.focus();
    if (rows.value) rows.value.scrollTop = rows.value.scrollHeight; // the new row is at the end
  });
}
/** Prefill the add form from elsewhere in the app (the ledger's pronunciation flag). */
function prefill(t: string) {
  term.value = t;
  nextTick(() => termBox.value?.focus());
}
defineExpose({ prefill });

/** a window of a real line around the first hit — narration paragraphs run long */
function sample(e: LexEntry): string {
  const text = castStore.lexSample(props.bookId, e);
  const hit = hitsIn(text, [{ ...e, enabled: true }])[0];
  if (!hit) return "";
  let from = Math.max(0, hit.from - 60);
  if (from) from = text.indexOf(" ", from) + 1 || from; // don't start mid-word
  let to = Math.min(text.length, hit.to + 90);
  if (to < text.length) to = Math.max(hit.to, text.lastIndexOf(" ", to));
  return (from ? "…" : "") + text.slice(from, to).trim() + (to < text.length ? "…" : "");
}
const preview = (e: LexEntry) => marks(sample(e), [{ ...e, enabled: true }]);
const said = (e: LexEntry) => speak(sample(e), [{ ...e, enabled: true }]).text;
// clips rendered before a term changed still carry the old spelling
const staleChapters = computed(() =>
  libraryStore.chaptersOf(props.bookId).filter((c) => c.narration === "stale"),
);
// `changedSegments` also holds never-rendered lines, which the run below renders too.
const staleLines = computed(() =>
  staleChapters.value.reduce(
    (a, c) => a + narrationStore.changedSegments(props.bookId, c.id).length,
    0,
  ),
);
const overrides = computed(() => castStore.pauseOverrides(props.bookId));
const PRESETS = [0.2, 0.35, 0.6, 1];
/** the pauses inside a line, and the lengths offered for each */
const INLINE = [
  { k: "inlineShort", label: "Short pause", presets: [0.25, 0.4, 0.6] },
  { k: "inlineLong", label: "Long pause", presets: [0.75, 1, 1.5, 2] },
] as const;
</script>

<template>
  <div class="grid min-w-0 grid-cols-1 md:grid-cols-[minmax(0,1fr)_270px]">
    <div class="min-w-0 p-3 sm:p-4">
      <div class="mb-2 flex flex-wrap items-baseline gap-x-2">
        <span class="label">Dictionary</span>
        <span class="text-[11px] text-zinc-500"
          >{{ plural(list.length, "term")
          }}<span v-if="unused" :data-tip="`not found in the scripted chapters`">
            · {{ unused }} unused</span
          >
          · applied to every request, never to the book text</span
        >
        <div v-if="book" class="ml-auto flex items-center gap-1.5 text-[11px] text-zinc-500">
          <UiSwitch
            :model-value="!book.pronounceOff"
            label="Suggest from scripting"
            @update:model-value="(on: boolean) => libraryStore.setPronounce(bookId, on)"
          />
          <UiHint
            label="suggested terms"
            text="The scripting model adds names and made-up words a voice may say wrong. They arrive switched off: check one in its preview, then switch it on."
          />
        </div>
      </div>

      <form :class="[GRID, 'mb-1 text-xs']" @submit.prevent="add">
        <input
          ref="termBox"
          v-model="term"
          class="input min-w-0 py-1"
          placeholder="as written, e.g. Lan’er"
          aria-label="Term as written in the book"
        />
        <span class="text-center text-zinc-400">→</span>
        <input
          v-model="say"
          class="input min-w-0 py-1"
          placeholder="say it as, e.g. Lahn-urr"
          aria-label="How it should be said"
        />
        <button
          class="btn-primary btn-xs col-span-3 justify-self-end"
          :disabled="!term.trim() || !say.trim()"
          type="submit"
        >
          <AddIcon class="icon-sm" /> Add
        </button>
      </form>

      <div
        ref="rows"
        class="-mx-1 max-h-[210px] divide-y divide-zinc-100 overflow-y-auto px-1 dark:divide-zinc-800"
      >
        <div v-for="e in list" :key="e.id" class="py-1.5">
          <div :class="[GRID, 'text-xs']">
            <input
              :value="e.term"
              class="input min-w-0 flex-1 py-1"
              :class="!e.enabled && 'text-zinc-400 line-through'"
              aria-label="Term"
              @change="
                castStore.updateTerm(bookId, e.id, {
                  term: ($event.target as HTMLInputElement).value,
                })
              "
            />
            <span class="text-center text-zinc-400">→</span>
            <input
              :value="e.say"
              class="input min-w-0 flex-1 py-1 font-mono"
              :class="!e.enabled && 'text-zinc-400'"
              aria-label="Said as"
              @change="
                castStore.updateTerm(bookId, e.id, {
                  say: ($event.target as HTMLInputElement).value,
                })
              "
            />
            <button
              class="text-right text-[11px]"
              :class="
                uses[e.id]
                  ? 'text-zinc-500 hover:text-violet-500'
                  : 'text-zinc-300 dark:text-zinc-600'
              "
              :data-tip="
                uses[e.id]
                  ? `${uses[e.id]} occurrence${uses[e.id] === 1 ? '' : 's'} in the scripted chapters — click for the preview`
                  : 'this spelling does not occur in the scripted chapters'
              "
              @click="open = open === e.id ? null : e.id"
            >
              {{ uses[e.id] || "—" }}×
            </button>
            <UiSwitch
              :model-value="e.enabled"
              @update:model-value="
                (v: boolean) => castStore.updateTerm(bookId, e.id, { enabled: v })
              "
              ><span class="sr-only">Apply {{ e.term }}</span></UiSwitch
            >
            <button
              class="icon-btn shrink-0 hover:!border-red-400 hover:!text-red-500"
              data-tip="remove this term"
              aria-label="remove this term"
              @click="castStore.removeTerm(bookId, e.id)"
            >
              <RemoveIcon class="icon-sm" />
            </button>
          </div>
          <!-- what it does to a real line -->
          <div
            v-if="open === e.id"
            class="mt-1.5 rounded bg-zinc-50 p-2 text-[11px] dark:bg-zinc-800/60"
          >
            <template v-if="sample(e)">
              <p class="text-zinc-600 dark:text-zinc-300">
                <template v-for="(m, i) in preview(e)" :key="i"
                  ><span v-if="m.say" class="lex">{{ m.text }}</span
                  ><template v-else>{{ m.text }}</template></template
                >
              </p>
              <p class="mt-1 font-mono text-violet-600 dark:text-violet-400">{{ said(e) }}</p>
            </template>
            <p v-else class="text-zinc-500">
              No scripted line contains “{{ e.term }}” — check the spelling, or script more
              chapters.
            </p>
            <div class="mt-2 flex flex-wrap items-center gap-3">
              <label class="flex items-center gap-1.5 text-zinc-500"
                ><UiCheckbox
                  size="xs"
                  :model-value="!!e.matchCase"
                  @update:model-value="
                    (v) => castStore.updateTerm(bookId, e.id, { matchCase: v === true })
                  "
                />match capitals exactly</label
              >
              <input
                :value="e.note ?? ''"
                class="input min-w-0 flex-1 py-0.5 text-[11px]"
                placeholder="note to yourself — why this entry exists"
                aria-label="Note"
                @change="
                  castStore.updateTerm(bookId, e.id, {
                    note: ($event.target as HTMLInputElement).value,
                  })
                "
              />
            </div>
          </div>
          <p v-else-if="e.note" class="truncate pl-1 text-[10px] text-zinc-400">{{ e.note }}</p>
        </div>
      </div>
      <p v-if="!list.length" class="py-4 text-center text-xs text-zinc-500">
        No terms yet. Add the names and invented words the voices get wrong — the book keeps its own
        spelling.
      </p>

      <div
        v-if="staleLines"
        class="mt-3 flex flex-wrap items-center gap-2 rounded bg-amber-400/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300"
      >
        <WarnIcon class="icon shrink-0" />
        <span class="min-w-0 flex-1"
          >{{ plural(staleLines, "line") }} across
          {{ plural(staleChapters.length, "chapter") }} need narrating again: their audio reads an
          older script or spelling, or was never rendered.</span
        >
        <button
          class="btn-ghost btn-xs shrink-0 border-amber-400"
          @click="narrationStore.renarrateStale(bookId)"
        >
          <RetryIcon class="icon-sm" /> Re-narrate them
        </button>
      </div>
    </div>

    <div
      class="min-w-0 border-t border-zinc-200 p-3 sm:p-4 md:border-l md:border-t-0 dark:border-zinc-800"
    >
      <div class="label mb-2">Pacing</div>
      <p class="mb-3 text-[11px] leading-relaxed text-zinc-500">
        Silence is stitched between clips, not rendered — changing it re-times the chapter and costs
        nothing.
      </p>
      <div class="space-y-3">
        <div v-for="k in ['line', 'turn'] as const" :key="k">
          <div class="flex items-center justify-between gap-2 text-xs">
            <span>{{ k === "line" ? "After a line" : "When the speaker changes" }}</span>
            <UiNumber
              class="w-[4.5rem] text-xs"
              :model-value="pacing[k]"
              :min="0"
              :max="5"
              :step="0.05"
              unit="s"
              :label="k === 'line' ? 'Gap after a line' : 'Gap when the speaker changes'"
              @update:model-value="
                (v: number | null) => castStore.setPacing(bookId, { [k]: v ?? 0 })
              "
            />
          </div>
          <div class="mt-1 flex flex-wrap gap-1">
            <button
              v-for="v in PRESETS"
              :key="v"
              class="chip"
              :class="pacing[k] === v && 'chip-on'"
              @click="castStore.setPacing(bookId, { [k]: v })"
            >
              {{ secs(v) }}
            </button>
          </div>
        </div>
      </div>
      <div class="mt-4 flex items-center gap-1.5">
        <span class="label">Pauses inside a line</span
        ><UiHint
          label="pauses inside a line"
          text="The pauses the scripting model writes, and the short and long ones you place on a line. They are sent with the line, so a new length makes the lines holding one need re-narrating; a pause given its own length keeps it."
        />
      </div>
      <div class="mt-2 space-y-3">
        <div v-for="p in INLINE" :key="p.k">
          <div class="flex items-center justify-between gap-2 text-xs">
            <span>{{ p.label }}</span>
            <UiNumber
              class="w-[4.5rem] text-xs"
              :model-value="pacing[p.k]"
              :min="0"
              :max="5"
              :step="0.05"
              unit="s"
              :label="p.label"
              @update:model-value="
                (v: number | null) => castStore.setPacing(bookId, { [p.k]: v ?? 0 })
              "
            />
          </div>
          <div class="mt-1 flex flex-wrap gap-1">
            <button
              v-for="v in p.presets"
              :key="v"
              class="chip"
              :class="pacing[p.k] === v && 'chip-on'"
              @click="castStore.setPacing(bookId, { [p.k]: v })"
            >
              {{ secs(v) }}
            </button>
          </div>
        </div>
      </div>
      <button
        v-if="book?.pacing"
        class="btn-ghost btn-xs mt-3"
        :data-tip="`back to ${secs(DEFAULT_PACING.line)} / ${secs(DEFAULT_PACING.turn)}, pauses ${secs(DEFAULT_PACING.inlineShort)} / ${secs(DEFAULT_PACING.inlineLong)}`"
        @click="castStore.resetPacing(bookId)"
      >
        Reset to default
      </button>

      <div class="mt-4">
        <div class="label mb-1">Per-line pauses</div>
        <p v-if="!overrides.length" class="text-[11px] leading-relaxed text-zinc-500">
          None yet. A single line can hold or run on — set it in the reader, under Boundaries.
        </p>
        <div v-else class="flex flex-wrap gap-1">
          <RouterLink
            v-for="o in overrides"
            :key="o.chId + '-' + o.seg.id"
            class="chip"
            :to="`/book/${bookId}/scripting?ch=${o.chId}&seg=${o.seg.id}`"
            :data-tip="o.seg.text.slice(0, 70)"
          >
            {{ libraryStore.chapterRef(bookId, o.chId) }} · #{{ o.seg.id }} ·
            {{ o.seg.pause === 0 ? "no gap" : secs(o.seg.pause!) }}
          </RouterLink>
        </div>
      </div>
    </div>
  </div>
</template>
