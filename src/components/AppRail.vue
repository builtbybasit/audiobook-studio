<script setup lang="ts">
// The sidebar's body.
//
// Desktop: an icon rail for the three app places — Library, Queue, Endpoints. Badges carry the
// counts and tooltips the words; the chevron at the foot widens it to show labels and counts.
// The open book is not here: it lives in the header (BookSelector, BookTabs), so the rail never
// repeats it.
//
// Narrow screens: the drawer. Full rows with labels, and under them the open book's pages with
// their counts — the header's tab row does not fit a phone, so the pages live here instead.
import { useLibraryStore } from "@/stores/library";
import { useUiStore } from "@/stores/ui";

import { computed } from "vue";
import { UiTooltip } from "@/ui";
import {
  BookOpen as OverviewIcon,
  ChevronsLeft as CollapseIcon,
  ChevronsRight as ExpandIcon,
  Inbox as ReviewIcon,
  LibraryBig as LibraryIcon,
  ListOrdered as QueueIcon,
  ListTree as ContentsIcon,
  Mic as NarrationIcon,
  Package as ExportIcon,
  PenLine as ScriptingIcon,
  Search as SearchIcon,
  Server as EndpointsIcon,
  Users as CastIcon,
} from "@lucide/vue";
import { useShell } from "@/composables/useShell";

const libraryStore = useLibraryStore();
const uiStore = useUiStore();
const {
  book,
  facts,
  waiting,
  castCount,
  activeKey,
  activeJobs,
  etaMinutes,
  endpointsNeedingAttention,
} = useShell();
const base = computed(() => (book.value ? `/book/${book.value.id}` : ""));

interface Item {
  key: string;
  to: string;
  icon: unknown;
  label: string;
  /** the figure beside the label, when there is room for words */
  count?: string;
  /** a number worth a badge on the icon */
  badge?: number;
  /** something worth a dot on the icon */
  dot?: "amber" | "emerald";
  /** the count is a warning, not a fact */
  warn?: boolean;
}
const app = computed<Item[]>(() => [
  { key: "library", to: "/library", icon: LibraryIcon, label: "Library" },
  {
    key: "queue",
    to: "/queue",
    icon: QueueIcon,
    label: "Queue",
    count: activeJobs.value
      ? `${activeJobs.value}${etaMinutes.value ? ` · ~${etaMinutes.value}m` : ""}`
      : "",
    badge: activeJobs.value,
    dot: activeJobs.value ? "emerald" : undefined,
  },
  {
    key: "endpoints",
    to: "/endpoints",
    icon: EndpointsIcon,
    label: "Endpoints",
    count: endpointsNeedingAttention.value ? `${endpointsNeedingAttention.value} to fix` : "",
    dot: endpointsNeedingAttention.value ? "amber" : undefined,
    warn: !!endpointsNeedingAttention.value,
  },
]);
/** the open book's pages, for the drawer */
const pages = computed<Item[]>(() => {
  const b = book.value;
  const f = facts.value;
  if (!b || !f) return [];
  const p = f.progress;
  const c = libraryStore.contentsOf(b.id);
  return [
    { key: "overview", to: base.value, icon: OverviewIcon, label: "Overview" },
    {
      key: "contents",
      to: `${base.value}/contents`,
      icon: ContentsIcon,
      label: "Contents",
      count: c.skipped ? `${c.included}/${c.total}` : `${c.total}`,
    },
    {
      key: "cast",
      to: `${base.value}/cast`,
      icon: CastIcon,
      label: "Cast",
      count: `${castCount.value}`,
    },
    {
      key: "review",
      to: `${base.value}/review`,
      icon: ReviewIcon,
      label: "Review",
      count: `${waiting.value}`,
      warn: !!waiting.value,
    },
    { key: "search", to: `${base.value}/search`, icon: SearchIcon, label: "Search" },
    {
      key: "scripting",
      to: `${base.value}/scripting`,
      icon: ScriptingIcon,
      label: "Scripting",
      count: `${f.failedScripting ? `${f.failedScripting} failed · ` : ""}${p.scripted}/${p.total}`,
      warn: !!f.failedScripting,
    },
    {
      key: "narration",
      to: `${base.value}/narration`,
      icon: NarrationIcon,
      label: "Narration",
      count: `${p.stale ? `${p.stale} stale · ` : ""}${p.narrated}/${p.total}`,
      warn: !!p.stale || !!f.failedNarration,
    },
    {
      key: "export",
      to: `${base.value}/export`,
      icon: ExportIcon,
      label: "Export",
      count: f.latest
        ? `v${f.latest.version}${f.behind ? " · behind" : ""}`
        : f.building
          ? "building…"
          : "—",
      warn: f.behind,
    },
  ];
});
const DOT = { amber: "bg-amber-500", emerald: "bg-emerald-500" };
const ROW =
  "flex items-center gap-3 rounded-lg px-2.5 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800";
const ROW_ON =
  "bg-violet-50 font-semibold text-violet-700 dark:bg-violet-500/10 dark:text-violet-300";
const RAIL =
  "relative flex h-9 items-center gap-3 rounded-lg text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100";
const RAIL_ON = "bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300";
const on = (k: string, cls: string) => activeKey.value === k && cls;
const countCls = (i: Item) =>
  i.warn ? "text-amber-600 dark:text-amber-400" : i.badge ? "text-emerald-500" : "text-zinc-400";
</script>

<template>
  <!-- narrow screens: the drawer, with words -->
  <nav class="mt-1 flex flex-col gap-0.5 px-2 lg:hidden">
    <RouterLink v-for="a in app" :key="a.key" :to="a.to" :class="[ROW, on(a.key, ROW_ON)]">
      <component :is="a.icon" class="icon text-zinc-400" />
      <span class="flex-1">{{ a.label }}</span>
      <span v-if="a.count" class="text-[11px]" :class="countCls(a)">{{ a.count }}</span>
    </RouterLink>
    <template v-if="book && pages.length">
      <div class="label mt-4 truncate px-2.5 pb-1">{{ book.title }}</div>
      <RouterLink v-for="pg in pages" :key="pg.key" :to="pg.to" :class="[ROW, on(pg.key, ROW_ON)]">
        <component :is="pg.icon" class="icon text-zinc-400" />
        <span class="flex-1">{{ pg.label }}</span>
        <span
          v-if="pg.count"
          class="whitespace-nowrap text-[11px] tabular-nums"
          :class="countCls(pg)"
          >{{ pg.count }}</span
        >
      </RouterLink>
    </template>
  </nav>

  <!-- desktop: the rail, icons only unless widened -->
  <nav
    class="mt-2 hidden flex-col gap-1 lg:flex"
    :class="uiStore.railExpanded ? 'px-2' : 'items-center'"
  >
    <template v-for="a in app" :key="a.key">
      <UiTooltip
        v-if="!uiStore.railExpanded"
        :text="a.count ? `${a.label} · ${a.count}` : a.label"
        side="right"
      >
        <RouterLink
          :to="a.to"
          :class="[RAIL, 'w-9 justify-center', on(a.key, RAIL_ON)]"
          :aria-label="a.label"
        >
          <component :is="a.icon" class="icon-lg" />
          <span
            v-if="a.badge"
            class="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-emerald-500 px-1 text-[9px] font-bold text-white"
            >{{ a.badge }}</span
          >
          <span
            v-else-if="a.dot"
            class="absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-white dark:ring-zinc-900"
            :class="DOT[a.dot]"
          ></span>
        </RouterLink>
      </UiTooltip>
      <RouterLink v-else :to="a.to" :class="[RAIL, 'w-full px-2.5', on(a.key, RAIL_ON)]">
        <component :is="a.icon" class="icon-lg" />
        <span class="flex-1 text-sm">{{ a.label }}</span>
        <span v-if="a.count" class="text-[11px]" :class="countCls(a)">{{ a.count }}</span>
      </RouterLink>
    </template>
    <button
      class="mt-1 flex h-8 items-center gap-3 rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      :class="uiStore.railExpanded ? 'w-full px-2.5' : 'w-9 justify-center'"
      :title="uiStore.railExpanded ? 'Collapse the sidebar' : 'Expand the sidebar'"
      :aria-expanded="uiStore.railExpanded"
      @click="uiStore.railExpanded = !uiStore.railExpanded"
    >
      <component :is="uiStore.railExpanded ? CollapseIcon : ExpandIcon" class="icon" />
      <span v-if="uiStore.railExpanded" class="text-xs">Collapse</span>
    </button>
  </nav>
</template>
