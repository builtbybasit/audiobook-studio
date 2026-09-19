<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";

// How this book is *said*: the pronunciation dictionary on the left, the pacing defaults on the right.
// Neither one edits the book — a term is swapped on its way to the endpoint and silence is stitched
// between clips — but they differ in cost: a respelling needs the line rendered again, a pause does not.
// Click a term for its preview against a real line, plus match-case and a note.
import { computed, nextTick, ref } from "vue";

import { UiNumber, UiSwitch } from "@/ui";
import { hitsIn, marks, speak, DEFAULT_PACING, secs } from "@/lib/speech";
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
// one column template for the add form and every row, so the two fields line up down the list
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
// The count is the store's own list, not a second copy of it: `renarrateStale` queues
// `changedSegments` — the stale clips *and*, in a chapter that has been narrated, the lines that
// were never rendered — so counting only the stale ones here promised N and rendered more.
const staleLines = computed(() =>
  staleChapters.value.reduce(
    (a, c) => a + narrationStore.changedSegments(props.bookId, c.id).length,
    0,
  ),
);
// One `renarrateStale` per chapter rather than one `runNarration` over all of them: the `fill`
// scope is not the same set of lines. It also takes the failed ones, it takes never-rendered lines
// in a chapter nobody has started, and it leaves out a line whose retake is still waiting for a
// verdict — so a single run would queue work this button never counted. The loop is safe because
// `_expressionGuard` merges a second block into the review already open rather than replacing it.
function renarrate() {
  for (const c of staleChapters.value) narrationStore.renarrateStale(props.bookId, c.id);
}
const overrides = computed(() => castStore.pauseOverrides(props.bookId));
const PRESETS = [0.2, 0.35, 0.6, 1];
</script>

<template>
  <div class="grid min-w-0 grid-cols-1 md:grid-cols-[minmax(0,1fr)_270px]">
    <!-- dictionary -->
    <div class="min-w-0 p-3 sm:p-4">
      <div class="mb-2 flex flex-wrap items-baseline gap-x-2">
        <span class="label">Dictionary</span>
        <span class="text-[11px] text-zinc-500"
          >{{ list.length }} term{{ list.length === 1 ? "" : "s"
          }}<span v-if="unused" :title="`not found in the scripted chapters`">
            · {{ unused }} unused</span
          >
          · applied to every request, never to the book text</span
        >
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
              :title="
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
              title="remove this term"
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
                ><input
                  type="checkbox"
                  :checked="!!e.matchCase"
                  @change="
                    castStore.updateTerm(bookId, e.id, {
                      matchCase: ($event.target as HTMLInputElement).checked,
                    })
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
          >{{ staleLines }} line{{ staleLines === 1 ? "" : "s" }} across
          {{ staleChapters.length }} chapter{{ staleChapters.length === 1 ? "" : "s" }} need
          narrating again: their audio reads an older script or spelling, or was never
          rendered.</span
        >
        <button class="btn-ghost btn-xs shrink-0 border-amber-400" @click="renarrate">
          <RetryIcon class="icon-sm" /> Re-narrate them
        </button>
      </div>
    </div>

    <!-- pacing -->
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
      <button
        v-if="book?.pacing"
        class="btn-ghost btn-xs mt-3"
        :title="`back to ${secs(DEFAULT_PACING.line)} / ${secs(DEFAULT_PACING.turn)}`"
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
            :title="o.seg.text.slice(0, 70)"
          >
            ch {{ o.chId }} · #{{ o.seg.id }} ·
            {{ o.seg.pause === 0 ? "no gap" : secs(o.seg.pause!) }}
          </RouterLink>
        </div>
      </div>
    </div>
  </div>
</template>
