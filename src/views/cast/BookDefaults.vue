<script setup lang="ts">
// The book's defaults above the Cast table: the Character voice (for a speaker with no voice,
// before the Narrator's) and the thought effect; beside them the library's line effects. Kept out
// of the table so a sort or j/k never has to step around them.
import { computed, nextTick, ref } from "vue";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import {
  AudioLines as LineIcon,
  Cloud as ThoughtIcon,
  Mic as VoiceIcon,
  Plus as AddIcon,
  X as RemoveIcon,
} from "@lucide/vue";

import { AGES } from "@/lib/cast";
import { lineEffectsOf } from "@/lib/prompt";
import { useCastStore } from "@/stores/cast";
import { useEffectsStore } from "@/stores/effects";
import { useLibraryStore } from "@/stores/library";
import { UiHint, UiToggleGroup } from "@/ui";
import VoicePicker from "@/components/VoicePicker.vue";
import { thoughtReach } from "@/views/cast/effects/lines";
import LineEffectsSheet from "@/views/cast/effects/LineEffectsSheet.vue";
import type { Age, CastStat, CharacterVoice, GenderSlot, VoiceRef } from "@/types";

const props = defineProps<{
  bookId: string;
  /** the Cast page's line counts, so the thought lines are not counted twice */
  stats: Record<string, CastStat>;
  /** whether every scripted chapter is in, so the counts are counts */
  counted: boolean;
}>();
/** the book's thought-effect sheet; `tune` opens its editor, `tuneLine` a line effect's */
const emit = defineEmits<{ thoughts: []; tune: [id: string]; tuneLine: [id: string] }>();
const libraryStore = useLibraryStore();
const castStore = useCastStore();
const effectsStore = useEffectsStore();

// ---------- the Character voice ----------
const cv = computed(() => libraryStore.bookById(props.bookId)?.characterVoice);
// A setting with every slot empty is cleared, so the mode picked before any voice is chosen lives
// here until a voice gives it something to be saved with.
const picked = ref<CharacterVoice["by"]>("one");
const by = computed(() => cv.value?.by ?? picked.value);

const GENDER_SLOTS: { slot: GenderSlot; label: string }[] = [
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
/** Fill or empty slots; the setting is cleared once no slot, age voices too, names a voice. */
function save(patch: Partial<CharacterVoice>) {
  const next: CharacterVoice = {
    one: null,
    male: null,
    female: null,
    other: null,
    ...cv.value,
    by: by.value,
    ...patch,
  };
  if (!next.ages?.length) delete next.ages;
  const empty = !next.one && !next.male && !next.female && !next.other && !next.ages;
  void libraryStore.setCharacterVoice(props.bookId, empty ? null : next);
}

// An age row stays shown once added, but only one with a voice is saved in `ages`.
const shownAges = ref<string[]>([]);
const key = (slot: GenderSlot, age: Age) => `${slot}:${age}`;
const ageVoice = (slot: GenderSlot, age: Age) =>
  cv.value?.ages?.find((a) => a.slot === slot && a.age === age)?.voice ?? null;
const ageRows = (slot: GenderSlot) =>
  AGES.filter((age) => ageVoice(slot, age) || shownAges.value.includes(key(slot, age)));
const freeAges = (slot: GenderSlot) => AGES.filter((age) => !ageRows(slot).includes(age));
/** the "+ Age" menu open, by gender; the age row whose picker is open */
const menuFor = ref<GenderSlot | null>(null);
const picking = ref<string | null>(null);

async function addAge(slot: GenderSlot, age: Age) {
  shownAges.value.push(key(slot, age));
  menuFor.value = null;
  await nextTick();
  picking.value = key(slot, age);
}
function setAge(slot: GenderSlot, age: Age, voice: VoiceRef | null) {
  if (!shownAges.value.includes(key(slot, age))) shownAges.value.push(key(slot, age));
  const others = (cv.value?.ages ?? []).filter((a) => a.slot !== slot || a.age !== age);
  save({ ages: voice ? [...others, { slot, age, voice }] : others });
}
function removeAge(slot: GenderSlot, age: Age) {
  shownAges.value = shownAges.value.filter((k) => k !== key(slot, age));
  if (ageVoice(slot, age)) setAge(slot, age, null);
}

// ---------- the thought effect ----------
/** The book's own choice, or null when it follows the library's. */
const own = computed(() => libraryStore.bookById(props.bookId)?.thoughts ?? null);
/** The effect the book's thought lines get — its own choice, else the library's; none for None. */
const thoughtEffect = computed(() =>
  effectsStore.byId.get(own.value ?? effectsStore.libraryThoughts),
);
const thoughtName = computed(() =>
  effectsStore.loaded ? (thoughtEffect.value?.name ?? "None") : "…",
);
const reach = computed(() => thoughtReach(castStore.charactersOf(props.bookId), props.stats));

// ---------- the line effects ----------
const lineEffects = computed(() => lineEffectsOf(effectsStore.effects));
const editingLines = ref(false);
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
    <div class="grid border-zinc-200 sm:grid-cols-2 lg:grid-cols-3 dark:border-zinc-800">
      <div class="space-y-2 border-inherit px-4 py-3 sm:border-r">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="flex items-center gap-1.5 text-sm font-medium">
            <VoiceIcon class="icon-sm text-zinc-400" /> Character voice
            <UiHint
              label="the Character voice"
              text="Speakers with no voice of their own are read in it, and an empty one falls back to the Narrator’s voice. By gender, an age voice goes first to that gender’s speakers of that age."
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
          @update:model-value="(v) => save({ one: v })"
        />
        <div v-else class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1">
          <template v-for="g in GENDER_SLOTS" :key="g.slot">
            <span class="text-[11px] text-zinc-500">{{ g.label }}</span>
            <VoicePicker
              :model-value="cv?.[g.slot] ?? null"
              :book-id="bookId"
              null-label="Narrator’s voice"
              size="xs"
              block
              @update:model-value="(v) => save({ [g.slot]: v })"
            />
            <PopoverRoot
              :open="menuFor === g.slot"
              @update:open="(o) => (menuFor = o ? g.slot : null)"
            >
              <PopoverTrigger
                class="btn-ghost btn-xs gap-0.5 border-transparent px-1 text-zinc-500 disabled:invisible"
                :disabled="!freeAges(g.slot).length"
                :aria-label="`Add an age voice under ${g.label}`"
              >
                <AddIcon class="icon-sm" /> Age
              </PopoverTrigger>
              <!-- mounted only while open, as the book menu's -->
              <PopoverPortal v-if="menuFor === g.slot">
                <PopoverContent align="end" :side-offset="4" class="ui-popup w-36 p-1 text-xs">
                  <button
                    v-for="age in freeAges(g.slot)"
                    :key="age"
                    class="ui-item w-full text-xs hover:bg-violet-50 dark:hover:bg-violet-500/15"
                    @click="addAge(g.slot, age)"
                  >
                    {{ age }}
                  </button>
                </PopoverContent>
              </PopoverPortal>
            </PopoverRoot>
            <template v-for="age in ageRows(g.slot)" :key="age">
              <span class="pl-2 text-[11px] text-zinc-500">└ {{ age }}</span>
              <VoicePicker
                :model-value="ageVoice(g.slot, age)"
                :open="picking === key(g.slot, age)"
                :book-id="bookId"
                :null-label="`${g.label} voice`"
                size="xs"
                block
                @update:open="(o) => (picking = o ? key(g.slot, age) : null)"
                @update:model-value="(v) => setAge(g.slot, age, v)"
              />
              <button
                class="justify-self-center rounded px-0.5 text-zinc-400 hover:text-red-500"
                :aria-label="`Remove the ${g.label.toLowerCase()} ${age} voice`"
                data-tip="Remove this age voice"
                @click="removeAge(g.slot, age)"
              >
                <RemoveIcon class="icon-sm" />
              </button>
            </template>
          </template>
        </div>
      </div>
      <div class="space-y-2 border-inherit px-4 py-3 lg:border-r">
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
          <span v-if="counted" class="text-[11px] text-zinc-500">{{ reach }}</span>
        </div>
        <div class="flex items-center gap-1">
          <button class="btn-ghost btn-xs" @click="emit('thoughts')">Change for this book…</button>
          <button
            v-if="thoughtEffect"
            class="btn-ghost btn-xs"
            :aria-label="`Tune ${thoughtEffect.name}`"
            @click="emit('tune', thoughtEffect.id)"
          >
            Tune
          </button>
        </div>
      </div>
      <div
        class="space-y-2 border-t border-inherit px-4 py-3 sm:col-span-2 lg:col-span-1 lg:border-t-0"
      >
        <div class="flex items-center gap-1.5 text-sm font-medium">
          <LineIcon class="icon-sm text-zinc-400" /> Line effects
          <span
            class="rounded bg-zinc-100 px-1 text-[10px] font-normal text-zinc-500 dark:bg-zinc-800"
            >All books</span
          >
          <UiHint
            label="line effects"
            text="The scripting model puts one on a line when its words say so — a phone, a mask. The line hears it after its speaker’s own effect."
          />
        </div>
        <ul v-if="lineEffects.length" class="space-y-0.5 text-xs">
          <li v-for="e in lineEffects" :key="e.id" class="flex items-baseline gap-2">
            <span class="shrink-0 font-medium">{{ e.name }}</span>
            <span class="min-w-0 flex-1 truncate text-zinc-500" :data-tip="e.useWhen">{{
              e.useWhen
            }}</span>
          </li>
        </ul>
        <p v-else-if="effectsStore.loaded" class="text-xs text-zinc-500">None offered yet.</p>
        <button class="btn-ghost btn-xs" @click="editingLines = true">Edit line effects…</button>
      </div>
    </div>
  </section>

  <LineEffectsSheet v-model:open="editingLines" @tune="(id) => emit('tuneLine', id)" />
</template>
