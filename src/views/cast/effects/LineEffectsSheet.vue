<script setup lang="ts">
// The library's line effects: each effect's "Use when" sentence offers it to the scripting model;
// a blank one is not offered. "Tune" opens the effects sheet on it.
import { DialogTitle } from "reka-ui";
import { X as CloseIcon } from "@lucide/vue";

import { useEffects } from "@/queries";
import { useEffectsStore } from "@/stores/effects";
import { UiHint, UiSheet } from "@/ui";

const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ tune: [id: string] }>();
useEffects();
const effectsStore = useEffectsStore();

function tune(id: string) {
  open.value = false;
  emit("tune", id);
}
</script>

<template>
  <UiSheet v-model:open="open" class="max-w-[720px]">
    <div class="flex items-center gap-2 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
      <DialogTitle class="font-semibold">Line effects</DialogTitle>
      <span class="rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-zinc-800"
        >All books</span
      >
      <UiHint
        label="line effects"
        text="Sent to the scripting model with every chapter: it may put these on a line, and only these. The “Use when” words are what it goes by; a blank one is not offered."
      />
      <button
        class="ml-auto rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
        aria-label="Close"
        @click="open = false"
      >
        <CloseIcon class="icon-lg" />
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto p-5 text-sm">
      <div
        class="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] gap-x-3 border-b border-zinc-200 pb-1 text-[11px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800"
      >
        <span>Effect</span><span>Use when…</span><span></span>
      </div>
      <div
        v-for="e in effectsStore.effects"
        :key="e.id"
        class="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-zinc-100 py-1.5 last:border-0 dark:border-zinc-800/70"
      >
        <span class="truncate" :title="e.name">{{ e.name }}</span>
        <input
          :value="e.useWhen ?? ''"
          maxlength="300"
          class="input w-full py-0.5 text-xs"
          placeholder="e.g. heard through a phone or radio"
          :aria-label="`When the model uses ${e.name}`"
          @input="effectsStore.update(e.id, { useWhen: ($event.target as HTMLInputElement).value })"
        />
        <button class="btn-ghost btn-xs" :aria-label="`Tune ${e.name}`" @click="tune(e.id)">
          Tune
        </button>
      </div>
      <p v-if="effectsStore.loaded && !effectsStore.effects.length" class="py-4 text-zinc-500">
        No effects yet.
      </p>
      <p class="mt-3 text-xs text-zinc-500">
        New effects are made from a speaker’s Effect list, then given a “Use when” here.
      </p>
    </div>
  </UiSheet>
</template>
