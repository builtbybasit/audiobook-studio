<script setup lang="ts">
// One row per volume — the name, where it runs, the counts, how long it would take to listen to,
// the file the export would write — and the range *is* the boundary: the start number carries ← →
// to move it; the red ✕ at the end joins the volume with the one before, with Undo in the toast.
//
// A click on the row opens it to its chapters as numbers, titles blurred; a click on a blurred
// title shows that one, the eye shows them all. Double-click the name to rename. Right-click the
// row for its menu. On the keyboard: ↑ ↓ move between rows, Enter opens, Delete joins, F2 renames.
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
import { safeName, shortVolume } from "@/lib/exports";
import type { VolumeRowInfo } from "@/lib/volumes";
import { MENU, MENU_ITEM, MENU_SEP, words } from "@/views/contents/shared";
import type { ContentsPage } from "@/views/contents/useContents";
import { UiHint } from "@/ui";
import {
  ChevronDown as OpenIcon,
  ChevronLeft as BackIcon,
  ChevronRight as FwdIcon,
  Eye as EyeIcon,
  EyeOff as EyeOffIcon,
  Scissors as CutIcon,
  X as JoinIcon,
} from "@lucide/vue";

const props = defineProps<{
  page: ContentsPage;
  v: VolumeRowInfo;
  index: number;
  picked?: boolean;
  hovered?: boolean;
}>();
const emit = defineEmits<{ hover: [id: number | null] }>();
const p = props.page;
const open = ref(false);
const reveal = ref(false);
const shown = ref(new Set<number>());
const show = (id: number) => (shown.value = new Set(shown.value).add(id));
const rows = computed(() => p.volumeRows.value);
const before = computed(() => rows.value[props.index - 1]);
const after = computed(() => rows.value[props.index + 1]);
/** ponytail: 155 words a minute, the usual audiobook pace; the real number comes from the clips once narrated */
function listening(n: number): string {
  const m = Math.round(n / 155);
  return m < 60 ? `${m} m` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} m`;
}
// The export names a volume's file as `planOf` in src/lib/exports.ts does, the book's title as
// the base; the Export page's file-name setting, when one is typed there, replaces the title.
const fileName = computed(
  () => `${safeName(p.book.value?.title ?? "audiobook")} - ${safeName(shortVolume(props.v.name))}`,
);

// ---- rename, on double-click, F2 or from the menu
const renaming = ref(false);
const nameInput = ref<HTMLInputElement | null>(null);
async function startRename() {
  renaming.value = true;
  await nextTick();
  nameInput.value?.focus();
  nameInput.value?.select();
}
function finishRename(value: string) {
  if (!renaming.value) return;
  renaming.value = false;
  p.rename(props.v.first.id, value);
}

// ---- keyboard
function onKey(e: KeyboardEvent) {
  if ((e.target as HTMLElement).tagName === "INPUT") return;
  const el = e.currentTarget as HTMLElement;
  const all = [...(el.closest("[data-rows]")?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
  const i = all.indexOf(el);
  if (e.key === "ArrowDown") all[i + 1]?.focus();
  else if (e.key === "ArrowUp") all[i - 1]?.focus();
  else if (e.key === "Enter" || e.key === " ") open.value = !open.value;
  else if ((e.key === "Delete" || e.key === "Backspace") && props.v.startsHere)
    p.joinAt(props.v.first.id);
  else if (e.key === "F2") startRename();
  else return;
  e.preventDefault();
}
const whole = () => ({ name: props.v.name, all: props.v.all, chapters: props.v.all });
</script>

<template>
  <div
    :id="`vrow-${p.bookId}-${v.id}`"
    class="border-b border-zinc-100 text-xs dark:border-zinc-800"
    :class="[
      picked && 'bg-violet-50 dark:bg-violet-500/10',
      hovered && 'bg-zinc-50 dark:bg-zinc-800/60',
    ]"
    @mouseenter="emit('hover', v.id)"
    @mouseleave="emit('hover', null)"
  >
    <ContextMenuRoot>
      <ContextMenuTrigger
        as="div"
        data-row
        tabindex="0"
        class="grid cursor-pointer items-center gap-3 px-2 py-1 outline-none focus-visible:bg-violet-50 dark:focus-visible:bg-violet-500/10"
        style="grid-template-columns: auto 170px 180px auto minmax(0, 1fr) auto"
        :aria-expanded="open"
        :aria-label="`${v.name}, chapters ${v.from ?? '—'} to ${v.to ?? '—'}`"
        @click="open = !open"
        @keydown="onKey"
      >
        <OpenIcon
          class="icon-sm text-zinc-400 transition-transform"
          :class="open && 'rotate-180'"
        />
        <input
          v-if="renaming"
          ref="nameInput"
          :value="v.name"
          class="input min-w-0 px-1 py-0.5 text-xs font-semibold"
          aria-label="Volume name"
          @click.stop
          @keydown.stop.enter="finishRename(($event.target as HTMLInputElement).value)"
          @keydown.stop.escape="renaming = false"
          @blur="finishRename(($event.target as HTMLInputElement).value)"
        />
        <span
          v-else
          class="min-w-0 truncate px-1 font-semibold"
          title="Double-click to rename"
          @dblclick.stop="startRename"
          >{{ v.name }}</span
        >
        <!-- the range, whose start is the boundary -->
        <div class="flex items-center gap-1 font-mono text-[11px]">
          <span class="text-zinc-400">ch</span>
          <template v-if="v.startsHere">
            <button
              class="icon-btn"
              :disabled="!v.room.back"
              title="start one chapter earlier (shift-click: ten)"
              @click.stop="p.moveStart(v.first.id, $event.shiftKey ? -10 : -1)"
            >
              <BackIcon class="icon-sm" />
            </button>
            <span class="font-semibold text-violet-700 dark:text-violet-300">{{
              v.from ?? "—"
            }}</span>
            <button
              class="icon-btn"
              :disabled="!v.room.forward"
              title="start one chapter later (shift-click: ten)"
              @click.stop="p.moveStart(v.first.id, $event.shiftKey ? 10 : 1)"
            >
              <FwdIcon class="icon-sm" />
            </button>
          </template>
          <span v-else class="font-semibold" title="the book starts here">{{ v.from ?? "—" }}</span>
          <span class="text-zinc-400">–</span>
          <span>{{ v.to ?? "—" }}</span>
        </div>
        <span class="whitespace-nowrap text-right font-mono text-zinc-500">
          {{ v.all.length }} ch<template v-if="v.included !== v.all.length">
            · {{ v.all.length - v.included }} skipped</template
          >
          · {{ words(v.words) }} · ~{{ listening(v.words) }}
        </span>
        <span
          class="min-w-0 truncate font-mono text-[10px] text-zinc-400"
          :title="`The export writes ${fileName}`"
          >{{ fileName }}</span
        >
        <button
          class="icon-btn border-red-300 text-red-600 hover:border-red-500 hover:bg-red-50 hover:text-red-700 dark:border-red-500/50 dark:text-red-400 dark:hover:bg-red-500/10"
          :class="!v.startsHere && 'invisible'"
          :title="`Join with ${before?.name ?? 'the volume before'} (Undo in the toast)`"
          :aria-label="`Join ${v.name} with ${before?.name ?? 'the volume before'}`"
          @click.stop="v.startsHere && p.joinAt(v.first.id)"
        >
          <JoinIcon class="icon-sm" />
        </button>
      </ContextMenuTrigger>
      <ContextMenuPortal>
        <ContextMenuContent :class="MENU">
          <ContextMenuLabel class="px-2 py-1 text-[10px] text-zinc-500"
            >{{ v.name }} · ch {{ v.from ?? "—" }}–{{ v.to ?? "—" }}</ContextMenuLabel
          >
          <ContextMenuItem :class="MENU_ITEM" @select="startRename"
            >Rename… <span class="ml-auto text-[10px] text-zinc-400">F2</span></ContextMenuItem
          >
          <ContextMenuItem :class="MENU_ITEM" @select="open = !open"
            >{{ open ? "Fold" : "Open" }}
            <span class="ml-auto text-[10px] text-zinc-400">↵</span></ContextMenuItem
          >
          <ContextMenuSeparator :class="MENU_SEP" />
          <ContextMenuItem
            :class="MENU_ITEM"
            :disabled="v.all.length < 2"
            @select="p.cutAt(v.all[Math.floor(v.all.length / 2)].id)"
            >Cut in the middle</ContextMenuItem
          >
          <ContextMenuItem
            :class="MENU_ITEM"
            :disabled="!v.startsHere"
            @select="p.joinAt(v.first.id)"
            >Join with {{ before?.name ?? "the volume before" }}
            <span class="ml-auto text-[10px] text-zinc-400">⌦</span></ContextMenuItem
          >
          <ContextMenuItem :class="MENU_ITEM" :disabled="!after" @select="p.joinAt(after!.first.id)"
            >Join with {{ after?.name ?? "the volume after" }}</ContextMenuItem
          >
          <ContextMenuSeparator :class="MENU_SEP" />
          <ContextMenuItem :class="MENU_ITEM" @select="p.toggleVolume(whole())">
            {{ v.included === v.all.length ? "Skip" : "Include" }} all {{ v.all.length }} chapters
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuPortal>
    </ContextMenuRoot>

    <!-- the chapters, by number; a title only when asked for -->
    <div
      v-if="open"
      class="border-t border-zinc-100 bg-zinc-50/60 px-2 py-1 dark:border-zinc-800 dark:bg-zinc-900/40"
    >
      <div class="mb-1 flex items-center gap-2 px-1 text-[10px] text-zinc-400">
        <span>{{ v.all.length }} chapters · titles hidden</span>
        <UiHint
          label="the chapter list"
          text="Click a blurred title to read that one; the eye shows them all. The scissors beside a chapter start a new volume there."
        />
        <button
          class="icon-btn ml-auto"
          :class="reveal && 'icon-btn-on'"
          :title="reveal ? 'Hide every title' : 'Show every title (spoilers)'"
          @click="reveal = !reveal"
        >
          <component :is="reveal ? EyeOffIcon : EyeIcon" class="icon-sm" />
        </button>
      </div>
      <div class="grid max-h-56 grid-cols-2 gap-x-6 overflow-auto lg:grid-cols-3">
        <div
          v-for="c in v.all"
          :key="c.id"
          class="group flex items-center gap-1.5 rounded px-1 py-px hover:bg-white dark:hover:bg-zinc-800"
          :class="c.excluded && 'text-zinc-400'"
        >
          <span class="w-9 shrink-0 font-mono text-[11px] text-zinc-400">{{
            p.numbers.value?.get(c.id) ?? "—"
          }}</span>
          <span
            class="min-w-0 flex-1 truncate"
            :class="[
              !(reveal || shown.has(c.id)) && 'cursor-pointer select-none blur-[4px]',
              c.excluded && 'line-through',
            ]"
            :aria-hidden="!(reveal || shown.has(c.id))"
            :title="reveal || shown.has(c.id) ? c.title : 'Click to read the title'"
            @click="show(c.id)"
            >{{ c.title }}</span
          >
          <button
            v-if="c.id !== v.first.id"
            class="icon-btn opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            title="New volume from here"
            :aria-label="`New volume from chapter ${p.numbers.value?.get(c.id) ?? 'here'}`"
            @click="p.cutAt(c.id)"
          >
            <CutIcon class="icon-sm" />
          </button>
        </div>
      </div>
      <button
        class="mt-1 w-full rounded py-0.5 text-center text-[10px] text-zinc-400 hover:bg-white dark:hover:bg-zinc-800"
        @click="open = false"
      >
        fold
      </button>
    </div>
  </div>
</template>
