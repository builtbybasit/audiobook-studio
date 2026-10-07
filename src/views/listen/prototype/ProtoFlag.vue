<script setup lang="ts">
// PROTOTYPE — throwaway. Flag a line while listening: what is wrong, a note, kept in memory.
import { ref, watch } from "vue";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { Flag as FlagIcon } from "@lucide/vue";
import { UiToggleGroup } from "@/ui";
import { FLAG_LABEL } from "@/lib/scriptReview";
import { protoFlags } from "@/views/listen/prototype/ctx";
import type { FlagKind, Segment } from "@/types";

const props = defineProps<{ segment: Segment; size?: "sm" | "lg"; label?: string }>();
const open = defineModel<boolean>("open", { default: false });
const KINDS: FlagKind[] = ["pronunciation", "delivery", "pause", "other"];
const kind = ref<FlagKind>("delivery");
const note = ref("");
watch(open, (v) => {
  if (!v) return;
  const f = protoFlags.get(props.segment.id);
  kind.value = f?.kind ?? "delivery";
  note.value = f?.note ?? "";
});
function save() {
  protoFlags.set(props.segment.id, { kind: kind.value, note: note.value.trim() });
  open.value = false;
}
function drop() {
  protoFlags.delete(props.segment.id);
  open.value = false;
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger
      :class="[
        size === 'lg' ? 'btn-ghost btn-xs' : 'icon-btn',
        protoFlags.has(segment.id) && 'icon-btn-flag',
      ]"
      :title="
        protoFlags.has(segment.id)
          ? FLAG_LABEL[protoFlags.get(segment.id)!.kind]
          : 'flag this line (f)'
      "
    >
      <FlagIcon class="icon-sm" /><span v-if="label">{{ label }}</span>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent align="end" :side-offset="6" class="ui-popup w-72 p-3 text-xs">
        <div class="label mb-2">What is wrong with this line?</div>
        <UiToggleGroup
          v-model="kind"
          block
          class="mb-2"
          :options="KINDS.map((k) => ({ value: k, label: FLAG_LABEL[k].split(' ').at(-1)! }))"
        />
        <textarea
          v-model="note"
          class="input mb-2 w-full resize-none"
          rows="2"
          placeholder="a note for the retake (optional)"
          @keydown.enter.meta.prevent="save"
        ></textarea>
        <div class="flex justify-between">
          <button
            v-if="protoFlags.has(segment.id)"
            class="btn-ghost btn-xs text-red-600"
            @click="drop"
          >
            Remove flag
          </button>
          <span v-else></span>
          <button class="btn-primary btn-xs" @click="save">Flag</button>
        </div>
        <p class="mt-2 text-[10px] text-zinc-500">prototype: kept in memory, not saved</p>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
