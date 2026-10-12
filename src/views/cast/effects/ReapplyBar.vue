<script setup lang="ts">
// A book's clips whose sound is older than their lines' effects, and the one way to bring them up
// to date. Re-apply is always asked for, never run on a change: an effect is tuned by ear over many
// small edits, and every one of them would otherwise set the whole book's clips going again.
//
// Clips made before an effect was kept apart from the voice's own file cannot be re-applied — the
// old effect is in the only file there is — so they are said on their own, and a book whose old
// sound is all of that kind has no button at all. Nor does a server that cannot run effects at all
// (`ready`): a Re-apply there could only fail, so the bar says why instead.
import { computed, ref } from "vue";

import { plural } from "@/lib/contents";
import { useStaleSound } from "@/queries";
import { useEffectsStore } from "@/stores/effects";
import { useJobsStore } from "@/stores/jobs";
import { UiHint } from "@/ui";

const props = defineProps<{ bookId: string }>();
const effectsStore = useEffectsStore();
const jobsStore = useJobsStore();
const { stale } = useStaleSound(() => props.bookId);

/** The book's Re-apply while it is queued or running; the jobs poll is the app's, always on. */
const job = computed(() =>
  jobsStore.activeJobs.find((j) => j.bookId === props.bookId && j.kind === "effects"),
);
/** the old-sound lines a Re-apply can redo; `lines` counts the ones it cannot too */
const redo = computed(() => (stale.value ? stale.value.lines - stale.value.unavailable : 0));
const unavailable = computed(() => stale.value?.unavailable ?? 0);
const cannotRun = computed(() => stale.value?.ready === false);

const asking = ref(false);
async function reapply() {
  asking.value = true;
  await effectsStore.reapply(props.bookId);
  asking.value = false;
}
</script>

<template>
  <div
    v-if="job || redo || unavailable"
    class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500"
  >
    <span v-if="job?.status === 'queued'">Re-apply is waiting in the queue</span>
    <span v-else-if="job">Re-applying this book’s effects · {{ Math.round(job.progress) }}%</span>
    <span v-else-if="redo && cannotRun" class="flex items-center gap-1">
      Voice effects can’t run on this machine
      <UiHint
        label="why effects can’t run"
        :text="`The server runs them with uv, and can’t find it. Install uv, restart the server, then Re-apply the ${plural(redo, 'line')} with the old sound.`"
      />
    </span>
    <span v-else-if="redo" class="flex items-center gap-2">
      {{ plural(redo, "line") }} in this book {{ redo === 1 ? "has" : "have" }} the old sound
      <button class="btn-primary btn-xs" :disabled="asking" @click="reapply">Re-apply</button>
    </span>
    <span v-if="unavailable" class="flex items-center gap-1 text-zinc-400">
      {{ plural(unavailable, "line") }} can’t be re-applied
      <UiHint
        label="lines that can’t be re-applied"
        text="They were made before effects were kept apart from the voice. Re-narrate them to change their sound."
      />
    </span>
  </div>
</template>
