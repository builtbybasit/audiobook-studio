<script setup lang="ts">
// One line of the chapter as it is read along: prose for narration, lifted a little for dialogue and
// thought with the speaker named beside it. A line with word marks is cut into its heard words, and
// each is a place to start listening from; the rest of the line starts the line.
//
// A component of its own so that the word moving on re-renders this line only: the page hands the
// lit word to the line under the playhead and -1 to every other, which does not change.
import { computed } from "vue";
import { piecesOf, type WordMark } from "@/lib/listen";
import type { Segment } from "@/types";

const props = defineProps<{
  segment: Segment;
  marks: WordMark[] | null;
  /** the line is under the playhead */
  on: boolean;
  /** the mark being said, or -1 */
  word: number;
  color: string;
}>();
const emit = defineEmits<{ seek: [at: number] }>();
const pieces = computed(() => (props.marks ? piecesOf(props.segment.text, props.marks) : null));
const kind = computed(() => props.segment.type);
</script>

<template>
  <div
    :id="'seg-' + segment.id"
    class="-mx-3 mb-3 cursor-pointer rounded-md px-3 py-1 transition-colors"
    :class="[
      on ? 'bg-violet-100/70 dark:bg-violet-500/15' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60',
      kind !== 'narration' && 'border-l-[3px]',
    ]"
    :style="kind !== 'narration' ? { borderLeftColor: color } : undefined"
    @click="emit('seek', 0)"
  >
    <div
      v-if="kind === 'dialogue' || kind === 'thought'"
      class="font-sans text-[11px] leading-normal"
      :style="{ color }"
    >
      {{ segment.speaker }}
    </div>
    <p
      :class="
        kind === 'thought' || kind === 'note' ? 'italic text-zinc-600 dark:text-zinc-300' : ''
      "
    >
      <template v-if="pieces"
        ><template v-for="(piece, i) in pieces" :key="i"
          ><span
            v-if="piece.mark != null"
            class="rounded-sm transition-colors"
            :class="
              piece.mark === word
                ? 'bg-violet-300/80 dark:bg-violet-400/40'
                : 'hover:underline hover:decoration-violet-400/60'
            "
            @click.stop="emit('seek', marks![piece.mark][2])"
            >{{ piece.text }}</span
          ><template v-else>{{ piece.text }}</template></template
        ></template
      ><template v-else>{{ segment.text }}</template>
    </p>
  </div>
</template>
