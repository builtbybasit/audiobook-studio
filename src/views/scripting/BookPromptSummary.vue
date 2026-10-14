<script setup lang="ts">
// One line on the prompt a run here would send, with a link to the Overview where it is edited.
// Also warns of dropped notes, since the run starts here.
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { ArrowRight as NextIcon, TriangleAlert as WarnIcon } from "@lucide/vue";
import { describeOrigin, resolvePrompt } from "@/lib/prompt";
import { droppedNotes } from "@/lib/promptNotes";
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";

const props = defineProps<{ bookId: string }>();

const endpointsStore = useEndpointsStore();
const libraryStore = useLibraryStore();
const scriptingStore = useScriptingStore();

const prompt = computed(() => libraryStore.bookById(props.bookId)?.prompt);
const profile = computed(() => scriptingStore.runProfile);
const resolved = computed(() =>
  resolvePrompt({
    library: endpointsStore.prompt,
    profile: profile.value?.prompt,
    book: prompt.value,
  }),
);
const dropped = computed(() =>
  droppedNotes(
    resolved.value,
    { book: prompt.value?.notes, endpoint: profile.value?.prompt?.notes },
    profile.value?.name ?? "",
    "book",
  ),
);
const notes = computed(() => (prompt.value?.notes.trim() ? "with notes" : "no notes"));
</script>

<template>
  <div class="space-y-1 text-[11px] text-zinc-500">
    <div class="flex items-baseline gap-2">
      <span class="label">Prompt</span>
      <span class="min-w-0 truncate text-zinc-700 dark:text-zinc-300"
        >{{ describeOrigin(resolved.origin) }} · {{ notes }}</span
      >
      <RouterLink
        :to="{ path: `/book/${bookId}`, hash: '#prompt' }"
        class="ml-auto shrink-0 text-violet-600 hover:underline dark:text-violet-400"
        >Edit on Overview <NextIcon class="icon-sm"
      /></RouterLink>
    </div>
    <p
      v-for="d in dropped"
      :key="d.owner"
      class="flex gap-1.5 text-amber-700 dark:text-amber-300"
      role="status"
    >
      <WarnIcon class="icon-sm mt-px shrink-0" />{{ d.text }}
    </p>
  </div>
</template>
