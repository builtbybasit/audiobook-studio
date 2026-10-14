<script setup lang="ts">
import { useNarrationStore } from "@/stores/narration";

// The ⚑ on a ledger row: say what is wrong with a clip, then flag it or retake now. A
// mispronunciation goes to the dictionary instead, since a retake would read the same spelling.
// `open` is a model because pages open it by key (`f`) too.
import { computed, ref, watch } from "vue";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { BookA as DictionaryIcon, Flag as FlagIcon } from "@lucide/vue";
import { UiToggleGroup } from "@/ui";
import { FLAG_LABEL } from "@/lib/scriptReview";
import { lineLink } from "@/views/narration/shared";
import type { FlagKind, Segment } from "@/types";

const props = defineProps<{ bookId: string; chapterId: number; segment: Segment }>();
/** a word the listener wants respelled, handed up to the pronunciation dictionary */
const emit = defineEmits<{ pronounce: [word: string] }>();
const open = defineModel<boolean>("open", { required: true });
const narrationStore = useNarrationStore();

// what a person can say is wrong; `heard` is only ever raised by a check by ear
const KINDS: FlagKind[] = ["pronunciation", "delivery", "pause", "other"];
const kind = ref<FlagKind>("delivery");
const note = ref("");
const word = ref("");

/** the word a TTS engine most likely tripped on: a capitalised one that doesn't open the line */
function likelyWord(s: Segment): string {
  const words = s.text
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
  return (
    words.slice(1).find((w) => /^\p{Lu}/u.test(w)) ??
    [...words].sort((a, b) => b.length - a.length)[0] ??
    ""
  );
}
watch(
  open,
  (now) => {
    if (!now) return;
    kind.value = props.segment.flag?.kind ?? "delivery";
    note.value = props.segment.flag?.note ?? "";
    word.value = likelyWord(props.segment);
  },
  { immediate: true },
);

const heard = computed(() => kind.value === "heard");
function save(alsoRetake: boolean) {
  // a heard flag stays the check's until a person says what is wrong in their own words
  if (!heard.value)
    void narrationStore.flagSegment(
      props.bookId,
      props.chapterId,
      props.segment.id,
      kind.value,
      note.value,
    );
  open.value = false;
  if (alsoRetake) narrationStore.retakeSegment(props.bookId, props.chapterId, props.segment.id);
}
function toDictionary() {
  save(false);
  if (word.value.trim()) emit("pronounce", word.value.trim());
}
function clear() {
  open.value = false;
  void narrationStore.clearFlag(props.bookId, props.chapterId, props.segment.id);
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger
      class="icon-btn"
      :class="segment.flag ? 'icon-btn-flag' : 'hover:!border-amber-400 hover:!text-amber-600'"
      :title="
        segment.flag
          ? `flagged: ${FLAG_LABEL[segment.flag.kind]}${segment.flag.note ? ' — ' + segment.flag.note : ''}`
          : 'flag what is wrong with this clip (f)'
      "
      ><FlagIcon class="icon-sm"
    /></PopoverTrigger>
    <PopoverPortal>
      <PopoverContent :side-offset="6" align="end" class="ui-popup w-80 p-3 text-xs">
        <div class="label mb-2">What is wrong with #{{ segment.id }}?</div>
        <p v-if="segment.flag?.kind === 'heard'" class="mb-2 text-[11px] text-zinc-500">
          A check by ear flagged it<template v-if="segment.flag.note"
            >: {{ segment.flag.note }}</template
          >. Pick a kind to flag it yourself.
        </p>
        <UiToggleGroup
          :model-value="kind"
          block
          :options="KINDS.map((k) => ({ value: k, label: k }))"
          @update:model-value="(v: string | number | null) => (kind = v as FlagKind)"
        />
        <input
          v-model="note"
          class="input mt-2 w-full py-1"
          placeholder="e.g. “Kael” is read as two words"
          @keydown.enter="save(false)"
        />
        <div v-if="kind === 'pronunciation'" class="mt-2 rounded bg-violet-500/5 p-2">
          <div class="mb-1.5 text-[11px] text-zinc-500">
            A retake reads the same spelling. Teach the book instead — the prose keeps the author’s
            spelling, the endpoint gets yours.
          </div>
          <div class="flex items-center gap-1.5">
            <input
              v-model="word"
              class="input min-w-0 flex-1 py-1"
              placeholder="the word"
              aria-label="Word to add to the dictionary"
            />
            <button
              class="btn-ghost btn-xs shrink-0"
              :disabled="!word.trim()"
              @click="toDictionary()"
            >
              <DictionaryIcon class="icon-sm" /> Add to dictionary
            </button>
          </div>
        </div>
        <p v-else class="mt-2 text-[11px] leading-relaxed text-zinc-500">
          A retake keeps this clip: you play both and decide. If the request was wrong rather than
          the render, change the voice, direction or the line itself first —
          <RouterLink
            :to="lineLink({ bookId, chapterId }, segment)"
            class="text-violet-600 underline hover:text-violet-500 dark:text-violet-400"
            >edit the line in the reader</RouterLink
          >.
        </p>
        <div class="mt-3 flex items-center gap-2">
          <button v-if="segment.flag" class="btn-ghost btn-xs mr-auto" @click="clear()">
            Clear flag
          </button>
          <button v-if="!heard" class="btn-ghost btn-xs ml-auto" @click="save(false)">
            Flag only
          </button>
          <button class="btn-primary btn-xs" :class="heard && 'ml-auto'" @click="save(true)">
            {{ heard ? "Retake" : "Flag & retake" }}
          </button>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
