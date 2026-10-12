<script setup lang="ts">
// The book's two defaults, in a card above the Cast table: the Character voice, what a speaker with
// no voice of their own is read in before the Narrator's, and the thought effect every thought line
// gets unless its speaker has their own. Both are the book's, not a speaker's, so neither is a row
// of the table — a row there had to be kept first whatever the sort and stepped over by j/k.
import { computed, ref } from "vue";
import { Cloud as ThoughtIcon, Mic as VoiceIcon } from "@lucide/vue";

import { plural } from "@/lib/contents";
import { useCastStore } from "@/stores/cast";
import { useEffectsStore } from "@/stores/effects";
import { useLibraryStore } from "@/stores/library";
import { UiHint, UiToggleGroup } from "@/ui";
import VoicePicker from "@/components/VoicePicker.vue";
import type { CastStat, CharacterVoice, VoiceRef } from "@/types";

const props = defineProps<{
  bookId: string;
  /** the Cast page's line counts, so the thought lines are not counted twice */
  stats: Record<string, CastStat>;
  /** whether every scripted chapter is in, so the counts are counts */
  counted: boolean;
}>();
/** the sheet for the book's thought effect */
const emit = defineEmits<{ thoughts: [] }>();
const libraryStore = useLibraryStore();
const castStore = useCastStore();
const effectsStore = useEffectsStore();

// ---------- the Character voice ----------
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

// ---------- the thought effect ----------
/** The book's own choice, or null when it follows the library's. */
const own = computed(() => libraryStore.bookById(props.bookId)?.thoughts ?? null);
/** What the book's thought lines get, by name: its own choice, else the library's. */
const thoughtName = computed(() => {
  if (!effectsStore.loaded) return "…";
  const choice = own.value ?? effectsStore.libraryThoughts;
  return (choice !== "none" && effectsStore.byId.get(choice)?.name) || "None";
});
/** Of the speakers with thought lines, how many get the book's effect and how many their own. */
const reach = computed(() => {
  const thinkers = castStore
    .charactersOf(props.bookId)
    .filter((c) => (props.stats[c.name]?.thoughts ?? 0) > 0);
  const theirOwn = thinkers.filter((c) => c.thoughts != null).length;
  return { using: thinkers.length - theirOwn, theirOwn };
});
</script>

<template>
  <section class="card">
    <div class="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
      <span class="label">Book defaults</span>
      <UiHint
        label="book defaults"
        text="What a speaker gets when they have nothing of their own."
      />
    </div>
    <div class="grid divide-zinc-200 sm:grid-cols-2 sm:divide-x dark:divide-zinc-800">
      <div class="space-y-2 px-4 py-3">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="flex items-center gap-1.5 text-sm font-medium">
            <VoiceIcon class="icon-sm text-zinc-400" /> Character voice
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
      </div>
      <div class="space-y-2 px-4 py-3">
        <div class="flex items-center gap-1.5 text-sm font-medium">
          <ThoughtIcon class="icon-sm text-zinc-400" /> Thoughts
          <UiHint
            label="the thought effect"
            text="Put on every thought line after its speaker’s own effect. A speaker can have their own from their row."
          />
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span
            class="chip pointer-events-none"
            :class="thoughtName === 'None' ? 'chip-off' : 'chip-on'"
            ><template v-if="own === null">follows all books: </template>{{ thoughtName }}</span
          >
          <span v-if="counted" class="text-[11px] text-zinc-500">
            <template v-if="reach.using || reach.theirOwn"
              >{{ plural(reach.using, "speaker") }} {{ reach.using === 1 ? "uses" : "use" }} it ·
              {{ reach.theirOwn }} {{ reach.theirOwn === 1 ? "has" : "have" }} their own</template
            >
            <template v-else>no thought lines yet</template>
          </span>
        </div>
        <button class="btn-ghost btn-xs" @click="emit('thoughts')">Change for this book…</button>
      </div>
    </div>
  </section>
</template>
