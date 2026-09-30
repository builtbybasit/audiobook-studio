<script setup lang="ts">
// The editor under an open line: its speaker, type and direction, its expressions, where it starts
// and ends, its words, and the pause after it. What it acts on is the reader's editing state
// (`segmentEditing.ts`), which the reader's keys act on too.
import { computed, toRef } from "vue";
import { directionOptions } from "@/lib/bulk";
import { plural } from "@/lib/contents";
import { modKey } from "@/lib/format";
import { PAUSE_STEPS, secs } from "@/lib/speech";
import { useScriptsStore } from "@/stores/scripts";
import ExpressionEditor from "@/components/ExpressionEditor.vue";
import WordStrip from "@/components/WordStrip.vue";
import { UiCombobox, UiSelect, UiTooltip } from "@/ui";
import {
  ChevronDown as ChevronDownIcon,
  ChevronUp as ChevronUpIcon,
  Scissors as SplitIcon,
  Trash2 as TrashIcon,
  Type as TextIcon,
} from "@lucide/vue";
import { TYPES, useScript } from "@/views/scripting/shared";
import { useSegmentEditing } from "@/views/scripting/segmentEditing";
import type { Segment, SegmentType } from "@/types";

const props = defineProps<{ bookId: string; chapterId: number; segment: Segment }>();
const s = toRef(props, "segment");
const scriptsStore = useScriptsStore();
const { segments, cast, counts, inChapter, colorOf } = useScript(props);
const {
  splitting,
  cutAt,
  joinPreview,
  nextOf,
  prevOf,
  mergedText,
  doSplit,
  doJoin,
  editingText,
  textDraft,
  startTextEdit,
  commitText,
  dropSegment,
  close,
  bookGap,
  setPause,
} = useSegmentEditing();

const typeOpts = TYPES.map((t) => ({ value: t, label: t }));
/** the rest of the cast: everyone with no line in this chapter */
const rest = computed(() => cast.value.filter((c) => !counts.value[c.name]));
const speakerOpts = computed(() => [
  ...inChapter.value.map((c) => ({
    value: c.name,
    label: c.name,
    color: c.color,
    group: "In this chapter",
    hint: plural(counts.value[c.name], "line"),
    keywords: c.aliases.join(" "),
  })),
  ...rest.value.map((c) => ({
    value: c.name,
    label: c.name,
    color: c.color,
    group: "Rest of cast",
    keywords: c.aliases.join(" "),
  })),
]);
// directions: presets + everything already used in this book, free text allowed
const dirOpts = computed(() => directionOptions(scriptsStore.segments, props.bookId));
const sameSpeakerCount = (x: Segment) =>
  segments.value.filter((y) => y.speaker === x.speaker && y.id !== x.id).length;
</script>

<template>
  <div
    class="-mt-1 mb-4 grid grid-cols-2 items-end gap-2 rounded-md border border-violet-300 bg-white p-2 font-sans text-xs leading-normal 2xl:grid-cols-[1fr_1fr_2fr] dark:border-violet-500/40 dark:bg-zinc-900"
    @click.stop
  >
    <!-- the editor's own header: which line this is, and the one way out -->
    <div
      class="col-span-2 -mt-0.5 flex items-center gap-2 border-b border-zinc-100 pb-1.5 2xl:col-span-3 dark:border-zinc-800"
    >
      <span class="font-mono text-[10px] text-zinc-400">#{{ s.id }}</span>
      <span class="font-medium" :style="{ color: colorOf(s.speaker) }">{{ s.speaker }}</span>
      <span class="text-zinc-400">· {{ s.type }}</span>
      <span
        v-if="s.edited"
        class="rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-zinc-800"
        >edited</span
      >
      <button
        class="btn-ghost btn-xs ml-auto"
        :class="editingText === s.id && 'border-violet-400 text-violet-700 dark:text-violet-300'"
        :aria-pressed="editingText === s.id"
        title="Correct the words of this line — a mis-heard name, a doubled sentence, a note that isn’t story"
        @click="editingText === s.id ? (editingText = null) : startTextEdit(s)"
      >
        <TextIcon class="icon-sm" /> Edit text
        <kbd class="rounded bg-zinc-100 px-1 text-[10px] dark:bg-zinc-800">e</kbd>
      </button>
      <button class="btn-ghost btn-xs" title="Close the editor (Esc)" @click="close">
        Done
        <kbd class="rounded bg-zinc-100 px-1 text-[10px] dark:bg-zinc-800">esc</kbd>
      </button>
    </div>
    <div
      v-if="editingText === s.id"
      class="col-span-2 space-y-1.5 border-b border-zinc-100 pb-2 2xl:col-span-3 dark:border-zinc-800"
    >
      <span class="text-zinc-400">Line text</span>
      <textarea
        :id="`seg-text-${s.id}`"
        v-model="textDraft"
        class="input min-h-24 w-full resize-y font-serif text-sm leading-relaxed"
        :class="s.type === 'thought' && 'italic'"
        spellcheck="true"
        @keydown.esc.stop="editingText = null"
        @keydown.enter.meta.prevent="commitText(s)"
        @keydown.enter.ctrl.prevent="commitText(s)"
      ></textarea>
      <div class="flex flex-wrap items-center gap-2">
        <button
          class="btn-primary btn-xs"
          :disabled="!textDraft.trim() || textDraft.trim() === s.text"
          @click="commitText(s)"
        >
          Save text
          <kbd class="rounded bg-white/20 px-1 text-[10px]">{{ modKey }}↵</kbd>
        </button>
        <button class="btn-ghost btn-xs" @click="editingText = null">Cancel</button>
        <span class="text-[10px] text-zinc-400">
          {{ textDraft.trim().length }} chars ·
          <template v-if="!textDraft.trim()"
            >a line can’t be empty — use Delete line instead</template
          ><template v-else
            >expressions follow the words they sit on<template v-if="s.audio.duration"
              >, and this line’s audio goes stale</template
            ></template
          >
        </span>
      </div>
    </div>
    <label
      >Speaker<UiCombobox
        :model-value="s.speaker"
        :options="speakerOpts"
        size="xs"
        class="mt-1"
        block
        @update:model-value="(v) => scriptsStore.setSpeaker(bookId, chapterId, s.id, String(v))"
    /></label>
    <label
      >Type<UiSelect
        :model-value="s.type"
        :options="typeOpts"
        size="xs"
        class="mt-1"
        block
        @update:model-value="
          (v) =>
            scriptsStore.updateSegment(bookId, chapterId, s.id, {
              type: v as SegmentType,
            })
        "
    /></label>
    <label class="col-span-2 2xl:col-span-1"
      >Direction <span class="text-zinc-400">— pick or type your own</span>
      <div class="mt-1 flex items-center gap-1">
        <UiCombobox
          :model-value="s.direction"
          :options="dirOpts"
          custom
          placeholder="e.g. whispered, hesitant"
          size="xs"
          class="min-w-0 flex-1"
          block
          @update:model-value="
            (v) =>
              scriptsStore.updateSegment(bookId, chapterId, s.id, {
                direction: String(v),
              })
          "
        />
        <UiTooltip
          :text="`Set “${s.direction || '—'}” on every ${s.speaker} line in this chapter (${sameSpeakerCount(s)} more)`"
          ><button
            class="btn-ghost btn-xs whitespace-nowrap"
            :disabled="!s.direction || !sameSpeakerCount(s)"
            @click="scriptsStore.applyDirection(bookId, chapterId, s.speaker, s.direction)"
          >
            → all {{ s.speaker.split(" ")[0] }}
          </button></UiTooltip
        >
      </div>
    </label>
    <ExpressionEditor
      :book-id="bookId"
      :chapter-id="chapterId"
      :segment="s"
      class="col-span-2 border-t border-zinc-200 pt-2 2xl:col-span-3 dark:border-zinc-800"
    />
    <!-- boundaries: the model grouped two speakers together, or cut a sentence in half -->
    <div
      class="col-span-2 space-y-2 border-t border-zinc-200 pt-2 2xl:col-span-3 dark:border-zinc-800"
      @mouseleave="joinPreview = null"
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-zinc-400">Boundaries</span>
        <button
          class="btn-ghost btn-xs"
          :class="splitting === s.id && 'border-violet-400 text-violet-700 dark:text-violet-300'"
          :aria-pressed="splitting === s.id"
          @click="((splitting = splitting === s.id ? null : s.id), (cutAt = null))"
        >
          <SplitIcon class="icon-sm" />
          {{ splitting === s.id ? "Cancel split" : "Split…" }}
          <kbd class="rounded bg-zinc-100 px-1 text-[10px] dark:bg-zinc-800">s</kbd>
        </button>
        <button
          v-if="prevOf(s)"
          class="btn-ghost btn-xs"
          @mouseenter="joinPreview = 'prev'"
          @focus="joinPreview = 'prev'"
          @blur="joinPreview = null"
          @click="doJoin(s, 'prev')"
        >
          <ChevronUpIcon class="icon-sm" /> Join up
        </button>
        <button
          v-if="nextOf(s)"
          class="btn-ghost btn-xs"
          @mouseenter="joinPreview = 'next'"
          @focus="joinPreview = 'next'"
          @blur="joinPreview = null"
          @click="doJoin(s, 'next')"
        >
          <ChevronDownIcon class="icon-sm" /> Join next
          <kbd class="rounded bg-zinc-100 px-1 text-[10px] dark:bg-zinc-800">m</kbd>
        </button>
        <div class="ml-auto flex items-center gap-2">
          <button
            v-if="segments.length > 1"
            class="btn-ghost btn-xs hover:border-red-300 hover:text-red-600 dark:hover:text-red-400"
            :title="`Drop #${s.id} from the chapter — the prose closes over it. Undoable from the toast.`"
            @click="dropSegment(s)"
          >
            <TrashIcon class="icon-sm" /> Delete line
          </button>
        </div>
      </div>

      <!-- split: the line as a strip of words, and both halves as they would come out -->
      <template v-if="splitting === s.id">
        <div
          class="rounded-md bg-zinc-50 p-3 leading-loose ring-1 ring-violet-300 dark:bg-zinc-800/50 dark:ring-violet-500/40"
          :class="s.type === 'thought' && 'italic'"
        >
          <WordStrip
            :text="s.text"
            mode="split"
            :expressions="s.expressions"
            :quote="s.type === 'dialogue' ? 'dialogue' : ''"
            verb="cut"
            @pick="(at) => doSplit(s, at)"
            @hover="(at) => (cutAt = at)"
            @cancel="((splitting = null), (cutAt = null))"
          />
        </div>
        <div v-if="cutAt != null" class="grid gap-1 sm:grid-cols-2">
          <div class="min-w-0 rounded border border-zinc-200 px-2 py-1 dark:border-zinc-700">
            <span class="font-mono text-[10px] text-zinc-400">#{{ s.id }}</span>
            <span class="font-medium" :style="{ color: colorOf(s.speaker) }">{{ s.speaker }}</span>
            <div class="truncate">{{ s.text.slice(0, cutAt).trimEnd() }}</div>
          </div>
          <div
            class="min-w-0 rounded border border-dashed border-violet-300 px-2 py-1 dark:border-violet-500/40"
          >
            <span class="font-mono text-[10px] text-zinc-400">new</span>
            <span class="font-medium" :style="{ color: colorOf(s.speaker) }">{{ s.speaker }}</span>
            <span class="text-[10px] text-zinc-400">· opens for a new speaker</span>
            <div class="truncate">{{ s.text.slice(cutAt).trimStart() }}</div>
          </div>
        </div>
        <p v-else class="text-violet-600 dark:text-violet-300">
          Click the gap where this line should be cut — the darker ticks end a sentence.
          <span class="text-violet-500/70">← → walk the gaps, Enter cuts, Esc cancels.</span>
        </p>
      </template>

      <!-- join: the merged line, and who would read it -->
      <div
        v-else-if="joinPreview && (joinPreview === 'prev' ? prevOf(s) : nextOf(s))"
        class="rounded border border-zinc-200 px-2 py-1 dark:border-zinc-700"
      >
        <span class="font-mono text-[10px] text-zinc-400"
          >#{{ (joinPreview === "prev" ? prevOf(s)! : s).id }}</span
        >
        <span
          class="font-medium"
          :style="{ color: colorOf((joinPreview === 'prev' ? prevOf(s)! : s).speaker) }"
          >{{ (joinPreview === "prev" ? prevOf(s)! : s).speaker }}</span
        >
        <span class="text-zinc-400">
          reads both ·
          {{
            joinPreview === "prev" ? `#${prevOf(s)!.id} + #${s.id}` : `#${s.id} + #${nextOf(s)!.id}`
          }}</span
        >
        <div class="line-clamp-2">{{ mergedText(s, joinPreview) }}</div>
        <div
          v-if="(joinPreview === 'prev' ? prevOf(s)!.speaker : nextOf(s)!.speaker) !== s.speaker"
          class="text-amber-600 dark:text-amber-400"
        >
          {{ joinPreview === "prev" ? s.speaker : nextOf(s)!.speaker }}’s words would be read by
          {{ (joinPreview === "prev" ? prevOf(s)! : s).speaker }}.
        </div>
      </div>
    </div>
    <!-- pacing: silence after this line. Stitched at build time, so no clip is invalidated. -->
    <div
      v-if="nextOf(s)"
      class="col-span-2 flex flex-wrap items-center gap-1.5 border-t border-zinc-200 pt-2 2xl:col-span-3 dark:border-zinc-800"
    >
      <span class="text-zinc-400">Pause after</span>
      <button
        v-for="v in PAUSE_STEPS"
        :key="String(v)"
        class="chip"
        :class="(s.pause ?? null) === v && 'chip-on'"
        @click="setPause(s, v)"
      >
        {{ v === null ? `book · ${secs(bookGap(s))}` : v === 0 ? "run on" : secs(v) }}
      </button>
    </div>
  </div>
</template>
