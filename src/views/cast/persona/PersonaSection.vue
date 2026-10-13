<script setup lang="ts">
// The persona part of a speaker's full record. Any speaker but the Narrator can be linked as a
// persona — a disguise — of another character, and is then read in that character's voice; a
// character who is no persona lists theirs, and adds one by name. Every change goes through the
// cast store's write, so a link the server refuses is said in the usual toast and read back.
import { computed, nextTick, ref } from "vue";

import { useCast } from "@/queries";
import { useCastStore } from "@/stores/cast";
import { NARRATOR, personaOwner } from "@/lib/cast";
import { plural } from "@/lib/contents";
import { UiHint, UiSelect } from "@/ui";
import { Plus as AddIcon, VenetianMask as MaskIcon } from "@lucide/vue";
import type { Character } from "@/types";

const props = defineProps<{
  bookId: string;
  c: Character;
  /** a speaker's line count, or null while the book's scripts are not all read */
  lines: (name: string) => number | null;
}>();

const castStore = useCastStore();
const { characters: cast } = useCast(props.bookId);
const byName = computed(() => castStore.byName[props.bookId] ?? new Map<string, Character>());
const owner = computed(() => personaOwner(props.c, byName.value));
// the personas of this speaker, in cast order
const mine = computed(() =>
  cast.value.filter((p) => personaOwner(p, byName.value)?.name === props.c.name),
);
// someone with personas of their own cannot be one: one level only, so a voice never chains
const ofOpts = computed(() =>
  cast.value
    .filter((x) => x.name !== props.c.name && x.name !== NARRATOR && !x.personaOf)
    .map((x) => ({ value: x.name, label: x.name, color: x.color })),
);
function link(of: string | number | null) {
  void castStore.updateCharacter(props.bookId, props.c.name, {
    personaOf: of == null ? undefined : String(of),
  });
}

const adding = ref(false);
const draft = ref("");
const input = ref<HTMLInputElement | null>(null);
const taken = computed(() => cast.value.some((x) => x.name === draft.value.trim()));
async function startAdd() {
  adding.value = true;
  draft.value = "";
  await nextTick();
  input.value?.focus();
}
function add() {
  if (!draft.value.trim()) adding.value = false;
  else if (castStore.addCharacter(props.bookId, draft.value, props.c.name)) adding.value = false;
}
</script>

<template>
  <div class="space-y-2 text-xs">
    <div class="flex flex-wrap items-center gap-2 font-medium">
      <MaskIcon class="icon-sm text-zinc-500" aria-hidden="true" />
      Persona of
      <UiSelect
        :model-value="owner?.name ?? null"
        :options="ofOpts"
        null-value="Not a persona"
        size="xs"
        class="w-48"
        :disabled="!!mine.length"
        :aria-label="`Who ${c.name} is a persona of`"
        @update:model-value="link"
      />
      <UiHint
        label="linking a persona"
        text="Link a masked stranger only once the book says who they are. Until then they keep a voice of their own, so the voice gives nothing away."
      />
      <span v-if="mine.length" class="font-normal text-zinc-500"
        >Not while {{ c.name }} has personas of their own.</span
      >
      <span v-else-if="owner" class="font-normal text-zinc-500"
        >Read in {{ owner.name }}’s voice.</span
      >
    </div>

    <div v-if="!owner" class="space-y-1.5">
      <div class="flex items-center gap-1.5">
        <span class="label">Personas</span>
        <UiHint
          label="personas"
          :text="`Other names ${c.name} goes by in disguise. Their lines are read in ${c.name}’s voice, with ${c.name}’s effect and then their own.`"
        />
      </div>
      <div
        v-for="p in mine"
        :key="p.name"
        class="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 px-2 py-1 dark:border-zinc-800"
      >
        <MaskIcon class="icon-sm text-zinc-500" aria-hidden="true" />
        <b>{{ p.name }}</b>
        <span v-if="p.aliases.length" class="text-zinc-500">a.k.a. {{ p.aliases.join(", ") }}</span>
        <span v-if="lines(p.name) != null" class="text-zinc-400"
          >· {{ plural(lines(p.name)!, "line") }}</span
        >
        <button
          class="btn-ghost btn-xs ml-auto"
          :title="`Remove ${p.name} from this book’s cast — their lines go to the Narrator`"
          @click="castStore.deleteCharacter(bookId, p.name)"
        >
          Remove
        </button>
      </div>
      <form v-if="adding" class="flex flex-wrap items-center gap-1" @submit.prevent="add">
        <input
          ref="input"
          v-model="draft"
          class="input w-48 py-0.5"
          placeholder="Name in disguise"
          :aria-label="`New persona of ${c.name}`"
          @keydown.esc="adding = false"
        />
        <button class="btn-primary btn-xs" type="submit" :disabled="taken">Add</button>
        <button class="btn-ghost btn-xs" type="button" @click="adding = false">Cancel</button>
        <span v-if="taken" class="text-[11px] text-amber-600 dark:text-amber-400"
          >already in the cast — link them from their own record</span
        >
      </form>
      <button v-else class="btn-ghost btn-xs" @click="startAdd">
        <AddIcon class="icon-sm" /> Add persona of {{ c.name }}
      </button>
    </div>
  </div>
</template>
