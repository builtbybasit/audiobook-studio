<script setup lang="ts">
// What the record shows behind its spoiler button: the model's profile (read-only), the user's own
// description that overrides it, and the facts the profile is written from. Mounted only once
// shown, so the facts are read then.
import { computed } from "vue";
import { Trash2 as RemoveIcon } from "@lucide/vue";

import { deleteFact, useFacts } from "@/queries";
import { useCastStore } from "@/stores/cast";
import { UiHint } from "@/ui";
import type { Character } from "@/types";

const props = defineProps<{
  bookId: string;
  c: Character;
  /** false: nothing was hidden, so nothing that would spoil is read */
  facts: boolean;
}>();

const castStore = useCastStore();
const { data } = useFacts(
  () => props.bookId,
  () => props.c.name,
  () => props.facts,
);
const facts = computed(() => (props.facts ? (data.value ?? []) : []));
const parts = computed(() =>
  (
    [
      ["Who", props.c.profile?.who],
      ["Personality", props.c.profile?.personality],
      ["Voice", props.c.profile?.voice],
    ] as const
  ).filter(([, text]) => text?.trim()),
);
</script>

<template>
  <div class="space-y-2">
    <div v-if="parts.length" class="space-y-1 font-normal leading-relaxed">
      <div class="flex items-center gap-1 font-medium">
        Profile
        <UiHint
          label="the profile"
          text="Written by the scripting model from the facts below, and rewritten as chapters are scripted. Your description, when there is one, is used instead."
        />
      </div>
      <p v-for="[label, text] in parts" :key="label" class="text-zinc-600 dark:text-zinc-300">
        <span class="text-zinc-400">{{ label }} ·</span> {{ text }}
      </p>
    </div>
    <div v-if="parts.length" class="flex items-center gap-1 font-medium">
      Your description
      <UiHint
        label="your description"
        text="Used in place of the profile wherever they’re described: scripting and voice picks. Blank uses the profile."
      />
    </div>
    <textarea
      :value="c.description"
      rows="4"
      class="input w-full resize-y font-normal leading-relaxed"
      :placeholder="parts.length ? 'Blank: the profile is used' : 'Who they are'"
      :aria-label="`Description of ${c.name}`"
      @input="
        castStore.updateCharacter(bookId, c.name, {
          description: ($event.target as HTMLTextAreaElement).value,
        })
      "
    ></textarea>
    <div v-if="facts.length" class="space-y-1">
      <div class="flex items-center gap-1 font-medium">
        Facts
        <UiHint
          label="facts"
          text="Lasting traits the book states, in reading order, each once: ×3 means three chapters said it. Removing a wrong one removes its repeats too and rebuilds the profile from the rest at the next rewrite; removing the last fact clears it now."
        />
      </div>
      <ul class="space-y-0.5 font-normal" :aria-label="`Facts about ${c.name}`">
        <li v-for="f in facts" :key="f.id" class="flex items-start gap-1.5">
          <span class="chip chip-off shrink-0">{{ f.kind }}</span>
          <div class="min-w-0 flex-1 leading-relaxed text-zinc-600 dark:text-zinc-300">
            <p>
              {{ f.text
              }}<span v-if="f.copies" class="ml-1 text-xs text-zinc-400">×{{ f.copies }}</span>
            </p>
            <details v-if="f.evidence" class="mt-1 text-xs">
              <summary class="cursor-pointer text-zinc-500">View source</summary>
              <blockquote
                class="mt-1 whitespace-pre-wrap border-l-2 border-zinc-300 pl-2 dark:border-zinc-600"
              >
                {{ f.evidence }}
              </blockquote>
            </details>
            <p v-else class="mt-1 text-xs text-zinc-400">
              No saved passage. Refresh profiles to collect one.
            </p>
          </div>
          <button
            type="button"
            class="shrink-0 rounded p-0.5 text-zinc-400 hover:text-red-500"
            aria-label="Remove this fact"
            data-tip="Remove — the profile is rewritten without it"
            @click="deleteFact(bookId, c.name, f.id)"
          >
            <RemoveIcon class="icon-sm" />
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
