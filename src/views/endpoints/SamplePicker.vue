<script setup lang="ts">
// The samples a clone or a keep is made from, as a form holds them: a picker that adds files, and
// a row per sample (`SampleRowItem`) to hear it, see it, trim it, remove it and — where the provider
// takes one — say what is said in it. Whatever rows the form hands over are held to the most
// the provider takes, and the cut is said; what else may stop them is the form's to say
// (`pickProblem`), since it is what blocks the button.
import { computed, ref, watch } from "vue";
import { Upload as PickIcon } from "@lucide/vue";
import { UiHint } from "@/ui";
import type { CloneSupport } from "@/lib/providers";
import { maxSamplesOf } from "@/lib/voiceSamples";
import {
  acceptOf,
  leftOutSaid,
  limitsSaid,
  pickOf,
  type SampleRow,
} from "@/views/endpoints/cloneForm";
import SampleRowItem from "@/views/endpoints/SampleRowItem.vue";

const props = defineProps<{ cloning: CloneSupport }>();
/** The person picked files by hand, as against rows the form filled in from elsewhere. */
const emit = defineEmits<{ pick: [] }>();
const rows = defineModel<SampleRow[]>({ required: true });
const many = computed(() => maxSamplesOf(props.cloning) > 1);
/** how many of the last pick did not fit, past the most one voice is made from */
const leftOut = ref(0);
watch(
  rows,
  (r) => {
    const cut = pickOf(r, props.cloning);
    if (cut.leftOut) {
      rows.value = cut.samples;
      leftOut.value = cut.leftOut;
    } else if (!r.length) leftOut.value = 0;
  },
  { immediate: true },
);

function pick(e: Event) {
  const el = e.target as HTMLInputElement;
  const picked = [...(el.files ?? [])].map((file) => ({ file, transcript: "" }));
  // a provider that takes one file is given the newest pick; one that takes many, both
  rows.value = many.value ? [...rows.value, ...picked] : picked;
  el.value = "";
  emit("pick");
}
function remove(i: number) {
  rows.value = rows.value.filter((_, j) => j !== i);
  leftOut.value = 0;
}
function set(i: number, row: SampleRow) {
  rows.value = rows.value.map((r, j) => (j === i ? row : r));
}
const asks = computed(() => props.cloning.transcript !== "none");
const must = computed(() => props.cloning.transcript === "required");
</script>

<template>
  <div class="space-y-1">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-xs font-medium">{{ many ? "Samples" : "Sample" }}</span>
      <UiHint label="samples" :text="cloning.advice" />
      <label class="btn-ghost btn-xs cursor-pointer">
        <PickIcon class="icon-sm" />
        {{ many ? "Add samples" : rows.length ? "Replace sample" : "Add sample" }}
        <input
          type="file"
          class="sr-only"
          :accept="acceptOf(cloning)"
          :multiple="many"
          :aria-label="many ? 'Add samples' : 'Add a sample'"
          @change="pick"
        />
      </label>
      <span class="text-[11px] text-zinc-500">{{ limitsSaid(cloning) }}</span>
      <span v-if="leftOut" class="text-[11px] text-amber-600 dark:text-amber-400">
        {{ leftOutSaid(leftOut, cloning) }}
      </span>
    </div>
    <ul v-if="rows.length" class="divide-y divide-zinc-100 dark:divide-zinc-800">
      <SampleRowItem
        v-for="(row, i) in rows"
        :key="`${i}:${row.file.name}`"
        :row="row"
        :asks="asks"
        :must="must"
        @change="(r) => set(i, r)"
        @remove="remove(i)"
      />
    </ul>
  </div>
</template>
