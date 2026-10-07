<script setup lang="ts">
// The book as one bar: a segment per volume, as long as its share of the chapters, and a handle at
// every boundary that drags along the bar to move it. The drag is drawn here and written once, on
// release — a boundary dragged across fifty chapters is one write and one Undo.
//
// Click a segment to pick its row; double-click the bar to cut it where the pointer is. Right-click
// a segment for its menu — rename, cut here, cut in the middle, join with the volume before or
// after, skip or include the whole volume — and right-click a handle for its own: move it by one or
// ten, delete it. A handle takes the keyboard too: ← → move it (shift for ten), Delete removes it.
// Chapters are named by number only: a title here would give the plot away.
import { computed, nextTick, ref } from "vue";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "reka-ui";
import { MENU, MENU_ITEM, MENU_SEP } from "@/views/contents/shared";
import type { ContentsPage } from "@/views/contents/useContents";
import type { VolumeRowInfo } from "@/lib/volumes";

const props = defineProps<{
  page: ContentsPage;
  picked: number | null;
  /** the volume a row below is hovering, lit here too */
  hovered?: number | null;
}>();
const emit = defineEmits<{ pick: [id: number]; hover: [id: number | null] }>();
const p = props.page;
const rows = computed(() => p.volumeRows.value);
const total = computed(() => p.chapters.value.length);
const SHADES = [
  "bg-violet-500/80",
  "bg-sky-500/80",
  "bg-emerald-500/80",
  "bg-amber-500/80",
  "bg-rose-500/80",
  "bg-teal-500/80",
];
const bar = ref<HTMLElement | null>(null);
const indexOf = computed(() => new Map(p.chapters.value.map((c, i) => [c.id, i])));
/** where each volume begins, as an index into the chapters; one past the end closes the last */
const starts = computed(() => rows.value.map((v) => indexOf.value.get(v.first.id) ?? 0));
/** the chapter index under a pointer */
function indexAt(e: { clientX: number }): number {
  const r = bar.value!.getBoundingClientRect();
  const f = (e.clientX - r.left) / r.width;
  return Math.max(0, Math.min(total.value - 1, Math.round(f * total.value)));
}
const pct = (n: number) => `${(n / total.value) * 100}%`;
const num = (i: number) => p.numbers.value?.get(p.chapters.value[i]?.id) ?? "—";
const hover = ref<number | null>(null);

// ---- drag a handle: drawn from `drag.at` until the pointer is released, then written once
const drag = ref<{ k: number; at: number } | null>(null);
const boundary = (n: number) =>
  drag.value?.k === n ? drag.value.at : (starts.value[n] ?? total.value);
function onHandleDown(e: PointerEvent, k: number) {
  if (e.button !== 0) return;
  drag.value = { k, at: starts.value[k] };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function onHandleMove(e: PointerEvent) {
  if (!drag.value) return;
  const { k } = drag.value;
  const lo = starts.value[k - 1] + 1;
  const hi = (starts.value[k + 1] ?? total.value) - 1;
  drag.value = { k, at: Math.max(lo, Math.min(hi, indexAt(e))) };
}
function onHandleUp() {
  if (!drag.value) return;
  const { k, at } = drag.value;
  drag.value = null;
  if (at !== starts.value[k]) p.moveStart(rows.value[k].first.id, at - starts.value[k]);
}
function onHandleKey(e: KeyboardEvent, v: VolumeRowInfo) {
  const step = e.shiftKey ? 10 : 1;
  if (e.key === "ArrowLeft") p.moveStart(v.first.id, -step);
  else if (e.key === "ArrowRight") p.moveStart(v.first.id, step);
  else if (e.key === "Delete" || e.key === "Backspace") p.joinAt(v.first.id);
  else return;
  e.preventDefault();
}

// ---- cutting on the bar
function cutAtIndex(i: number) {
  const c = p.chapters.value[i];
  if (!c) return;
  if (i > 0) p.cutAt(c.id);
  emit("pick", c.volumeId);
}
/** where the context menu was opened, so "cut here" cuts there */
const menuAt = ref(0);
const cutMiddle = (v: VolumeRowInfo) =>
  cutAtIndex(starts.value[rows.value.indexOf(v)] + Math.floor(v.all.length / 2));

// ---- rename, as a small input over the segment
const renaming = ref<number | null>(null);
const renameInput = ref<HTMLInputElement[] | null>(null);
async function startRename(id: number) {
  renaming.value = id;
  await nextTick();
  renameInput.value?.[0]?.focus();
  renameInput.value?.[0]?.select();
}
function finishRename(v: VolumeRowInfo, value: string) {
  if (renaming.value !== v.id) return;
  renaming.value = null;
  p.rename(v.first.id, value);
}
const whole = (v: VolumeRowInfo) => ({ name: v.name, all: v.all, chapters: v.all });
</script>

<template>
  <div class="relative h-9 w-full select-none" @pointerleave="hover = null">
    <div
      ref="bar"
      class="flex h-full w-full overflow-hidden rounded-md ring-1 ring-zinc-200 dark:ring-zinc-800"
      @pointermove="hover = indexAt($event)"
    >
      <ContextMenuRoot v-for="(v, i) in rows" :key="v.id">
        <ContextMenuTrigger
          as="button"
          class="relative flex h-full min-w-0 items-center justify-center truncate text-[11px] font-medium text-white"
          :class="[
            SHADES[i % SHADES.length],
            picked === v.id && 'ring-2 ring-inset ring-zinc-900 dark:ring-white',
            hovered === v.id && 'brightness-110 saturate-150',
            i > 0 && 'border-l-2 border-white dark:border-zinc-950',
          ]"
          :style="{ width: pct(boundary(i + 1) - boundary(i)) }"
          :title="`${v.name} · ${v.all.length} chapters · right-click for more`"
          @click="emit('pick', v.id)"
          @dblclick="cutAtIndex(indexAt($event))"
          @mouseenter="emit('hover', v.id)"
          @mouseleave="emit('hover', null)"
          @contextmenu="menuAt = indexAt($event)"
        >
          <input
            v-if="renaming === v.id"
            ref="renameInput"
            :value="v.name"
            class="w-full min-w-0 bg-white/90 px-1 text-center text-[11px] text-zinc-900 outline-none"
            aria-label="Volume name"
            @click.stop
            @keydown.enter="finishRename(v, ($event.target as HTMLInputElement).value)"
            @keydown.escape="renaming = null"
            @blur="finishRename(v, ($event.target as HTMLInputElement).value)"
          />
          <span v-else class="truncate">{{ v.all.length / total > 0.08 ? v.name : i + 1 }}</span>
        </ContextMenuTrigger>
        <ContextMenuPortal>
          <ContextMenuContent :class="MENU">
            <ContextMenuLabel class="px-2 py-1 text-[10px] text-zinc-500">
              {{ v.name }} · <template v-if="v.from != null">ch {{ v.from }}–{{ v.to }} · </template
              >{{ v.all.length }} chapters
            </ContextMenuLabel>
            <ContextMenuItem :class="MENU_ITEM" @select="startRename(v.id)"
              >Rename…</ContextMenuItem
            >
            <ContextMenuItem :class="MENU_ITEM" @select="emit('pick', v.id)">
              Go to its row
            </ContextMenuItem>
            <ContextMenuSeparator :class="MENU_SEP" />
            <ContextMenuItem
              :class="MENU_ITEM"
              :disabled="menuAt <= starts[i] || v.all.length < 2"
              @select="cutAtIndex(menuAt)"
            >
              Cut here
              <span class="ml-auto font-mono text-[10px] text-zinc-400"
                >before ch {{ num(menuAt) }}</span
              >
            </ContextMenuItem>
            <ContextMenuItem :class="MENU_ITEM" :disabled="v.all.length < 2" @select="cutMiddle(v)">
              Cut in the middle
            </ContextMenuItem>
            <ContextMenuItem
              :class="MENU_ITEM"
              :disabled="!v.startsHere"
              @select="p.joinAt(v.first.id)"
            >
              Join with {{ rows[i - 1]?.name ?? "the volume before" }}
            </ContextMenuItem>
            <ContextMenuItem
              :class="MENU_ITEM"
              :disabled="!rows[i + 1]"
              @select="p.joinAt(rows[i + 1].first.id)"
            >
              Join with {{ rows[i + 1]?.name ?? "the volume after" }}
            </ContextMenuItem>
            <ContextMenuSeparator :class="MENU_SEP" />
            <ContextMenuItem :class="MENU_ITEM" @select="p.toggleVolume(whole(v))">
              {{ v.included === v.all.length ? "Skip" : "Include" }} all {{ v.all.length }} chapters
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenuPortal>
      </ContextMenuRoot>
    </div>

    <!-- handles: one at every boundary, so every volume but the first -->
    <template v-for="(v, i) in rows" :key="'h' + v.id">
      <ContextMenuRoot v-if="v.startsHere">
        <ContextMenuTrigger
          as="button"
          class="absolute top-1/2 z-10 h-5 w-2 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none rounded-sm bg-zinc-900 shadow ring-2 ring-white outline-none focus-visible:ring-violet-500 active:cursor-grabbing dark:bg-white dark:ring-zinc-950"
          :style="{ left: pct(boundary(i)) }"
          :title="`Before ch ${num(boundary(i))} · drag to move · ← → keys · Delete joins · right-click for more`"
          :aria-label="`${v.name} starts before chapter ${num(boundary(i))}`"
          @pointerdown="onHandleDown($event, i)"
          @pointermove="onHandleMove"
          @pointerup="onHandleUp"
          @pointercancel="onHandleUp"
          @keydown="onHandleKey($event, v)"
        />
        <ContextMenuPortal>
          <ContextMenuContent :class="MENU">
            <ContextMenuLabel class="px-2 py-1 text-[10px] text-zinc-500">
              {{ v.name }} starts before ch {{ num(starts[i]) }}
            </ContextMenuLabel>
            <ContextMenuItem
              :class="MENU_ITEM"
              :disabled="!v.room.back"
              @select="p.moveStart(v.first.id, -1)"
            >
              One chapter earlier
            </ContextMenuItem>
            <ContextMenuItem
              :class="MENU_ITEM"
              :disabled="v.room.back < 10"
              @select="p.moveStart(v.first.id, -10)"
            >
              Ten earlier
            </ContextMenuItem>
            <ContextMenuItem
              :class="MENU_ITEM"
              :disabled="!v.room.forward"
              @select="p.moveStart(v.first.id, 1)"
            >
              One chapter later
            </ContextMenuItem>
            <ContextMenuItem
              :class="MENU_ITEM"
              :disabled="v.room.forward < 10"
              @select="p.moveStart(v.first.id, 10)"
            >
              Ten later
            </ContextMenuItem>
            <ContextMenuSeparator :class="MENU_SEP" />
            <ContextMenuItem :class="MENU_ITEM" @select="p.joinAt(v.first.id)">
              Join
              <span class="ml-auto text-[10px] text-zinc-400"
                >{{ rows[i - 1]?.name }} and {{ v.name }}</span
              >
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenuPortal>
      </ContextMenuRoot>
    </template>

    <div
      v-if="drag || hover != null"
      class="pointer-events-none absolute -top-6 -translate-x-1/2 whitespace-nowrap rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-white dark:bg-white dark:text-zinc-900"
      :style="{ left: pct(drag ? drag.at : hover!) }"
    >
      ch {{ num(drag ? drag.at : hover!) }}
    </div>
  </div>
</template>
