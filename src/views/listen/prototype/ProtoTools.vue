<script setup lang="ts">
// PROTOTYPE — throwaway. The player's tools in one cluster: repeat this line, flag it, speed (a
// picker or one cycling button), follow the reading, stop at the chapter's end.
import { computed } from "vue";
import { Crosshair as FollowIcon, Repeat1 as LoopIcon, Square as StopIcon } from "@lucide/vue";
import ProtoFlag from "@/views/listen/prototype/ProtoFlag.vue";
import { UiToggleGroup } from "@/ui";
import { RATES } from "@/composables/usePlayer";
import { focusRow, protoLoop, protoStopAtEnd, type ListenCtx } from "@/views/listen/prototype/ctx";

const props = defineProps<{ ctx: ListenCtx; rate?: "picker" | "cycle" }>();
const flagOpen = defineModel<number | null>("flagOpen", { default: null });
const now = computed(() => focusRow(props.ctx));
const rateOptions = RATES.map((r) => ({ value: r, label: `${r}×` }));
function backToLine() {
  props.ctx.setFollow(true);
  if (props.ctx.current != null)
    document
      .getElementById(`seg-${props.ctx.current}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
}
</script>

<template>
  <span class="flex items-center gap-1.5">
    <button
      class="icon-btn"
      :class="protoLoop != null && 'icon-btn-on'"
      :disabled="now == null"
      :title="
        protoLoop != null ? 'repeating this line — click to stop (r)' : 'repeat this line (r)'
      "
      @click="protoLoop = protoLoop == null ? (ctx.current ?? now?.id ?? null) : null"
    >
      <LoopIcon class="icon-sm" />
    </button>
    <ProtoFlag
      v-if="now"
      :segment="now"
      :open="flagOpen === now.id"
      @update:open="(v) => (flagOpen = v ? now!.id : null)"
    />
    <UiToggleGroup
      v-if="rate !== 'cycle'"
      :model-value="ctx.p.rate"
      :options="rateOptions"
      class="font-mono"
      @update:model-value="(r) => ctx.setRate(Number(r))"
    />
    <button
      v-else
      class="rounded border border-zinc-200 px-1 font-mono text-[10px] text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
      title="playback speed"
      @click="ctx.cycleRate()"
    >
      {{ ctx.p.rate }}×
    </button>
    <button
      class="icon-btn"
      :class="ctx.follow && 'icon-btn-on'"
      :title="ctx.follow ? 'following the reading — click to stop' : 'follow the reading'"
      @click="ctx.follow ? ctx.setFollow(false) : backToLine()"
    >
      <FollowIcon class="icon-sm" />
    </button>
    <button
      class="icon-btn"
      :class="protoStopAtEnd && 'icon-btn-on'"
      :title="
        protoStopAtEnd
          ? 'stops at the end of this chapter'
          : 'runs on into the next chapter — click to stop at the end'
      "
      @click="protoStopAtEnd = !protoStopAtEnd"
    >
      <StopIcon class="icon-sm" />
    </button>
  </span>
</template>
