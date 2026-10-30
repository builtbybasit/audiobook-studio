<script setup lang="ts">
// Read this book's scripted chapters again for cast facts, then rewrite the profiles from them:
// for books scripted before facts were kept, or to read them again on another endpoint.
import { computed, ref, watch } from "vue";
import { DialogDescription, DialogTitle } from "reka-ui";

import { useCastStore } from "@/stores/cast";
import { useLibraryStore } from "@/stores/library";
import { plural } from "@/lib/contents";
import { UiDialog, UiHint, UiNumber, UiSwitch } from "@/ui";
import ScriptProfileSelect from "@/views/scripting/ScriptProfileSelect.vue";

const props = defineProps<{ bookId: string }>();
const open = defineModel<boolean>("open", { default: false });

const castStore = useCastStore();
const libraryStore = useLibraryStore();

/** reading numbers of the chapters with a script, in order */
const scripted = computed(() =>
  libraryStore
    .chaptersOf(props.bookId)
    .filter((c) => c.scripting === "done")
    .map((c) => libraryStore.numberOf(props.bookId, c.id))
    .filter((n): n is number => n != null)
    .sort((a, b) => a - b),
);
const from = ref(1);
const to = ref(1);
const major = ref(false);
watch(open, (on) => {
  if (!on) return;
  from.value = scripted.value[0] ?? 1;
  to.value = scripted.value.at(-1) ?? 1;
  major.value = false;
});
const inRange = computed(() => scripted.value.filter((n) => n >= from.value && n <= to.value));
const why = computed(
  () =>
    castStore.aiBlocker ??
    (!inRange.value.length ? "No scripted chapters in this range" : undefined),
);
const sending = ref(false);
async function start() {
  sending.value = true;
  const ok = await castStore.refreshProfiles(props.bookId, {
    from: from.value,
    to: to.value,
    major: major.value,
  });
  sending.value = false;
  if (ok) open.value = false;
}
</script>

<template>
  <UiDialog v-model:open="open" placement="top" class="card w-[min(460px,94vw)] space-y-3 p-4">
    <DialogTitle class="flex items-center gap-1 font-semibold">
      Refresh profiles for this book
      <UiHint
        label="refreshing profiles"
        text="The original prose of each scripted chapter in the range is read for lasting, quoted facts about characters who speak or are mentioned, then their profiles are rewritten. Scripts and voices don’t change."
      />
    </DialogTitle>
    <DialogDescription class="sr-only">
      Read the original prose for cast facts and supporting excerpts, then rewrite the character
      profiles.
    </DialogDescription>

    <div class="flex items-center gap-2 text-xs">
      <span class="text-zinc-500">Endpoint</span><ScriptProfileSelect />
    </div>
    <div class="flex flex-wrap items-center gap-1.5 text-xs">
      <span>Chapters</span>
      <UiNumber
        :model-value="from"
        :min="1"
        class="w-14 text-xs"
        label="From chapter"
        @update:model-value="(v: number | null) => v != null && (from = v)"
      />
      <span>to</span>
      <UiNumber
        :model-value="to"
        :min="1"
        class="w-14 text-xs"
        label="To chapter"
        @update:model-value="(v: number | null) => v != null && (to = v)"
      />
    </div>
    <label class="flex items-center gap-2 text-xs"
      ><UiSwitch v-model="major" /> Main cast only</label
    >
    <p class="text-xs text-zinc-500">{{ plural(inRange.length, "scripted chapter") }} to read</p>
    <p v-if="castStore.aiBlocker" class="text-xs text-amber-600 dark:text-amber-400">
      {{ castStore.aiBlocker }}
    </p>

    <div class="flex justify-end gap-2">
      <button class="btn-ghost btn-xs" @click="open = false">Cancel</button>
      <button
        class="btn-primary btn-xs"
        :disabled="!!why || sending"
        :data-tip="why"
        @click="start"
      >
        Refresh
      </button>
    </div>
  </UiDialog>
</template>
