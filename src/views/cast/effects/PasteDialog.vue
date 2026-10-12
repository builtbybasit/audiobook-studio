<script setup lang="ts">
// Paste Python: Pedalboard code read into a chain by the server, never run. Opened from the list it
// makes a new effect, named after the board the code builds; opened from the editor it can instead
// replace the chain of the effect being edited (`into`). Why the code builds nothing is said under
// it, so the paste can be fixed where it is.
import { ref, watch } from "vue";
import { DialogTitle } from "reka-ui";
import { Loader2 as SpinIcon } from "@lucide/vue";

import { useEffectsStore } from "@/stores/effects";
import { UiDialog, UiHint, UiToggleGroup } from "@/ui";
import { nameFromCode, uniqueName } from "./chain";

const props = defineProps<{ into: { id: string; name: string } | null }>();
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ made: [id: string] }>();
const effectsStore = useEffectsStore();

const code = ref("");
const target = ref<"replace" | "new">("new");
const error = ref<string | null>(null);
const reading = ref(false);
watch(open, (o) => {
  if (!o) return;
  code.value = "";
  error.value = null;
  target.value = props.into ? "replace" : "new";
});

async function use() {
  reading.value = true;
  error.value = null;
  try {
    const read = await effectsStore.parse(code.value);
    if (!read) return;
    if ("error" in read) {
      error.value = read.error;
      return;
    }
    if (target.value === "replace" && props.into) {
      effectsStore.update(props.into.id, { chain: read.chain });
    } else {
      const name = uniqueName(
        nameFromCode(code.value),
        new Set(effectsStore.effects.map((e) => e.name)),
      );
      const made = await effectsStore.create(name, read.chain);
      if (!made) return;
      emit("made", made.id);
    }
    open.value = false;
  } finally {
    reading.value = false;
  }
}
</script>

<template>
  <UiDialog v-model:open="open" class="card w-[min(640px,94vw)] space-y-3 p-4">
    <div class="flex items-center gap-2">
      <DialogTitle class="font-semibold">Paste Python</DialogTitle>
      <UiHint
        label="pasting Python"
        text="The code is read, never run: plugin calls with numbers, Pedalboard, Mix and names given to them."
      />
    </div>
    <textarea
      v-model="code"
      class="input h-72 w-full resize-y font-mono text-xs leading-relaxed"
      spellcheck="false"
      placeholder="board = Pedalboard([HighpassFilter(170), Reverb(room_size=0.3)])"
      aria-label="Pedalboard Python"
    ></textarea>
    <p v-if="error" class="text-xs text-red-600 dark:text-red-400">{{ error }}</p>
    <div class="flex items-center gap-2">
      <UiToggleGroup
        v-if="into"
        v-model="target"
        :options="[
          { value: 'replace', label: `Replace ${into.name}`, class: 'normal-case' },
          { value: 'new', label: 'New effect', class: 'normal-case' },
        ]"
        aria-label="Where the pasted steps go"
      />
      <button class="btn-ghost btn-xs ml-auto" @click="open = false">Cancel</button>
      <button class="btn-primary btn-xs" :disabled="!code.trim() || reading" @click="use">
        <SpinIcon v-if="reading" class="icon-sm animate-spin" />
        {{ target === "replace" && into ? `Replace ${into.name}` : "Make the effect" }}
      </button>
    </div>
  </UiDialog>
</template>
