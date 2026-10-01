<script setup lang="ts">
// The Cast table's first row, whatever the sort: the book's Character voice, what a speaker with
// no voice of their own is read in before the Narrator's. It is a book setting, not a speaker, so
// it has no box, no record and no ×, and no `data-row` — j/k step over it.
import { computed, ref } from "vue";

import { useLibraryStore } from "@/stores/library";
import { UiHint, UiToggleGroup } from "@/ui";
import VoicePicker from "@/components/VoicePicker.vue";
import type { CharacterVoice, VoiceRef } from "@/types";

const props = defineProps<{ bookId: string }>();
const libraryStore = useLibraryStore();

const cv = computed(() => libraryStore.bookById(props.bookId)?.characterVoice);
// A setting with every slot empty is cleared, so the mode picked before any voice is chosen lives
// here until a voice gives it something to be saved with.
const picked = ref<CharacterVoice["by"]>("one");
const by = computed(() => cv.value?.by ?? picked.value);

type Slot = Exclude<keyof CharacterVoice, "by">;
const GENDER_SLOTS: { slot: Slot; label: string }[] = [
  { slot: "male", label: "Male" },
  { slot: "female", label: "Female" },
  { slot: "other", label: "Other" },
];
const MODES = [
  { value: "one", label: "One voice", class: "normal-case" },
  { value: "gender", label: "By gender", class: "normal-case" },
];

/** Switch mode; both shapes are kept, so the other mode's voices come back when switched back. */
function setBy(next: CharacterVoice["by"]) {
  picked.value = next;
  if (cv.value) void libraryStore.setCharacterVoice(props.bookId, { ...cv.value, by: next });
}
/** Fill or empty one slot; the setting is cleared once no slot names a voice. */
function setSlot(slot: Slot, voice: VoiceRef | null) {
  const next: CharacterVoice = {
    one: null,
    male: null,
    female: null,
    other: null,
    ...cv.value,
    by: by.value,
    [slot]: voice,
  };
  const empty = !next.one && !next.male && !next.female && !next.other;
  void libraryStore.setCharacterVoice(props.bookId, empty ? null : next);
}
</script>

<template>
  <tr
    class="border-t border-zinc-100 bg-violet-50/40 dark:border-zinc-800/70 dark:bg-violet-500/[0.04]"
  >
    <td></td>
    <td class="py-2">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span class="flex items-center gap-1">
          <b>Character voice</b>
          <UiHint
            label="the Character voice"
            text="Speakers with no voice of their own are read in it, and an empty one falls back to the Narrator’s voice."
          />
        </span>
        <UiToggleGroup
          :model-value="by"
          :options="MODES"
          aria-label="Character voice mode"
          @update:model-value="(v) => setBy(v as CharacterVoice['by'])"
        />
      </div>
    </td>
    <td colspan="2"></td>
    <td class="py-1 pr-2">
      <VoicePicker
        v-if="by === 'one'"
        :model-value="cv?.one ?? null"
        :book-id="bookId"
        null-label="Narrator’s voice"
        size="xs"
        block
        @update:model-value="(v) => setSlot('one', v)"
      />
      <div v-else class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
        <template v-for="g in GENDER_SLOTS" :key="g.slot">
          <span class="text-[11px] text-zinc-500">{{ g.label }}</span>
          <VoicePicker
            :model-value="cv?.[g.slot] ?? null"
            :book-id="bookId"
            null-label="Narrator’s voice"
            size="xs"
            block
            @update:model-value="(v) => setSlot(g.slot, v)"
          />
        </template>
      </div>
    </td>
    <td></td>
  </tr>
</template>
