<script setup lang="ts">
// The "Volumes" tab: the bar stays pinned at the top as the map — click a segment to jump to its
// row, drag a handle to move a boundary — with the tools that cut the whole book at once on the
// same band, and one row per volume scrolling beneath.
import { ref } from "vue";
import VolumeTools from "@/views/contents/VolumeTools.vue";
import VolumeStrip from "@/views/contents/VolumeStrip.vue";
import VolumeRow from "@/views/contents/VolumeRow.vue";
import { UiHint } from "@/ui";
import type { ContentsPage } from "@/views/contents/useContents";

const props = defineProps<{ page: ContentsPage }>();
const p = props.page;
const picked = ref<number | null>(null);
const hovered = ref<number | null>(null);
function pick(id: number) {
  picked.value = id;
  document
    .getElementById(`vrow-${p.bookId}-${id}`)
    ?.scrollIntoView({ block: "start", behavior: "smooth" });
}
</script>

<template>
  <div>
    <div
      class="sticky top-0 z-20 border-b border-zinc-200 bg-white/95 px-4 pt-8 pb-3 backdrop-blur sm:px-6 dark:border-zinc-800 dark:bg-zinc-900/95"
    >
      <div class="mx-auto max-w-3xl">
        <VolumeStrip
          :page="p"
          :picked="picked"
          :hovered="hovered"
          @pick="pick"
          @hover="(id) => (hovered = id)"
        />
        <div class="mt-1 flex items-center justify-between font-mono text-[10px] text-zinc-400">
          <span>ch 1</span>
          <span class="flex items-center gap-1"
            >{{ p.volumeRows.value.length }} volumes · drag a handle to move a boundary
            <UiHint
              label="the volumes bar"
              text="Double-click the bar to cut it there. Right-click a volume or a handle for more. A handle takes ← → (shift: ten) and Delete, which joins. Every change has Undo in its toast; chapter numbers never move."
            />
          </span>
          <span>ch {{ p.summary.value.included }}</span>
        </div>
        <div class="mt-2">
          <VolumeTools :page="p" />
        </div>
      </div>
    </div>
    <div class="mx-auto max-w-5xl px-4 py-4 sm:px-6">
      <div class="card overflow-hidden" data-rows>
        <VolumeRow
          v-for="(v, i) in p.volumeRows.value"
          :key="v.id"
          class="scroll-mt-40"
          :page="p"
          :v="v"
          :index="i"
          :picked="picked === v.id"
          :hovered="hovered === v.id"
          @hover="(id) => (hovered = id)"
        />
      </div>
    </div>
  </div>
</template>
