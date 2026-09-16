<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useUiStore } from "@/stores/ui";

// App shell. Desktop: fixed sidebar. Narrow (< lg): top bar with a menu button that opens the same
// sidebar as a drawer. Also hosts the palette, toasts, the shortcuts dialog, global ⌘Z / ? keys,
// the "book finished" notifications and the document title (active job count).
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { keyring } from "@/lib/keyring";
import { usePlayer } from "@/composables/usePlayer";
import { endpointErrors, unifyEndpoint, unifyProfile } from "@/lib/endpoints";
import { reviewCount } from "@/views/review/inbox";
import JobIndicator from "@/components/JobIndicator.vue";
import CommandPalette from "@/components/CommandPalette.vue";
import DemoTools from "@/components/DemoTools.vue";
import {
  X as CloseIcon,
  Headphones as LogoIcon,
  Menu as MenuIcon,
  Moon as MoonIcon,
  Pause as PauseIcon,
  ListOrdered as QueueIcon,
  Server as EndpointsIcon,
  Search as SearchIcon,
  Sun as SunIcon,
} from "@lucide/vue";
import Toasts from "@/components/Toasts.vue";
import MiniPlayer from "@/components/MiniPlayer.vue";
import ShortcutsDialog from "@/components/ShortcutsDialog.vue";
import ExpressionReview from "@/components/ExpressionReview.vue";
import { TooltipProvider } from "reka-ui";

const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();
const narrationStore = useNarrationStore();
const uiStore = useUiStore();
const player = usePlayer();
const route = useRoute();
const drawer = ref(false);
const shortcuts = ref(false);
watch(
  () =>
    endpointsStore.endpoints.map((e) => JSON.stringify([e.id, e.model, e.baseUrl, e.expressions])),
  () => narrationStore.refreshExpressionAudio(),
);

watch(
  () => route.params.bookId,
  (id) => {
    // a book still in its contents review is not on the shelf yet, so it is not the open book
    if (id && !libraryStore.bookById(String(id))?.importing) uiStore.currentBookId = String(id);
  },
  { immediate: true },
);
watch(
  () => route.fullPath,
  () => {
    drawer.value = false;
  },
);
watch(
  () => uiStore.dark,
  (d) => document.documentElement.classList.toggle("dark", d),
  { immediate: true },
);
watch(
  () => jobsStore.activeJobs.length,
  (n) => {
    document.title = (n ? `(${n}) ` : "") + "Audiobook Studio · prototype";
  },
  { immediate: true },
);

// a book's run finished (it had active jobs, now none) → toast, and a browser notification if enabled
const activeByBook = computed(() => {
  const m: Record<string, number> = {};
  for (const j of jobsStore.activeJobs) m[j.bookId] = (m[j.bookId] ?? 0) + 1;
  return m;
});
watch(activeByBook, (now, before) => {
  for (const id of Object.keys(before ?? {})) {
    if (now[id]) continue;
    const b = libraryStore.bookById(id);
    if (!b) continue;
    const recent = jobsStore.jobs.filter(
      (j) => j.bookId === id && j.finishedAt && Date.now() - j.finishedAt < 5 * 60000,
    );
    const failed = recent.filter((j) => j.status === "failed").length;
    const cancelled = recent.filter((j) => j.status === "cancelled").length;
    if (recent.length && recent.every((j) => j.status === "cancelled")) continue;
    const desc = `${recent.length - failed - cancelled} done${failed ? ` · ${failed} failed` : ""}`;
    uiStore.toast(`${b.title}: run finished`, {
      kind: failed ? "warn" : "success",
      description: desc,
      action: {
        label: failed ? "See what failed" : "Open queue",
        run: () => router.push("/queue"),
      },
    });
    if (
      uiStore.notify &&
      "Notification" in window &&
      Notification.permission === "granted" &&
      document.hidden
    )
      new Notification("Audiobook Studio", { body: `${b.title}: run finished · ${desc}` });
  }
});
import { useRouter } from "vue-router";
const router = useRouter();

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable) return;
  if (e.key === " " && !["BUTTON", "A", "SUMMARY"].includes(t.tagName) && player.p.id) {
    e.preventDefault(); // the page would scroll otherwise
    player.toggle();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
    if (uiStore.undoLast()) e.preventDefault();
  } else if (e.key === "?" || (e.shiftKey && e.key === "/")) {
    e.preventDefault();
    shortcuts.value = true;
  }
}
const openShortcuts = () => {
  shortcuts.value = true;
};
onMounted(() => {
  window.addEventListener("keydown", onKey);
  window.addEventListener("open-shortcuts", openShortcuts);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("open-shortcuts", openShortcuts);
});

const stages: { key: string; label: string; to: (b: string | null) => string }[] = [
  { key: "library", label: "Library", to: () => "/library" },
  { key: "scripting", label: "Scripting", to: (b) => `/book/${b}/scripting` },
  { key: "narration", label: "Narration", to: (b) => `/book/${b}/narration` },
  { key: "export", label: "Export", to: (b) => `/book/${b}/export` },
];
const activeKey = computed(() =>
  route.path.match(/^\/book\/[^/]+$/) ? "overview" : route.path.split("/").pop(),
);
const p = computed(() =>
  uiStore.currentBookId ? libraryStore.progress(uiStore.currentBookId) : null,
);
/** Decisions waiting on the open book. The stage rows count work; this counts verdicts. */
const waiting = computed(() => (uiStore.currentBookId ? reviewCount(uiStore.currentBookId) : 0));
/** enabled endpoints that can't currently run: no key, or settings that don't validate */
const endpointsNeedingAttention = computed(
  () =>
    [
      ...endpointsStore.profiles.map(unifyProfile),
      ...endpointsStore.endpoints.map(unifyEndpoint),
    ].filter(
      (u) => u.enabled && ((u.needsKey && !keyring.has(u.slot)) || endpointErrors(u).length > 0),
    ).length,
);
const palette = ref<InstanceType<typeof CommandPalette> | null>(null);
const modKey = /Mac|iPhone/.test(navigator.platform) ? "⌘" : "Ctrl";
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <div class="flex h-screen">
      <!-- drawer backdrop (narrow screens) -->
      <div
        v-if="drawer"
        class="fixed inset-0 z-40 bg-black/40 lg:hidden"
        @click="drawer = false"
      ></div>
      <aside
        class="fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-white transition-transform lg:static lg:w-56 lg:translate-x-0 dark:border-zinc-800 dark:bg-zinc-900"
        :class="drawer ? 'translate-x-0' : '-translate-x-full'"
      >
        <div class="flex items-center gap-2 px-4 py-4">
          <div class="grid h-8 w-8 place-items-center rounded-lg bg-violet-600 text-white">
            <LogoIcon class="icon-lg" />
          </div>
          <div class="leading-tight">
            <div class="font-semibold">Audiobook Studio</div>
            <!-- the app runs on seeded data and simulated jobs; say so where the name is -->
            <div
              class="text-[10px] uppercase tracking-wider text-amber-500"
              title="Seeded books and simulated jobs. No provider is called and every cost shown is simulated."
            >
              demo mode · simulated costs
            </div>
          </div>
          <button
            class="ml-auto text-zinc-400 lg:hidden"
            aria-label="close menu"
            @click="drawer = false"
          >
            <CloseIcon class="icon" />
          </button>
        </div>

        <nav class="mt-2 flex flex-col gap-0.5 px-2">
          <template v-for="(s, i) in stages" :key="s.key">
            <RouterLink
              v-if="s.key === 'library' || uiStore.currentBookId"
              :to="s.to(uiStore.currentBookId)"
              class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
              :class="
                activeKey === s.key &&
                'bg-violet-50 font-semibold text-violet-700 dark:bg-violet-500/10 dark:text-violet-300'
              "
            >
              <span
                class="grid h-6 w-6 place-items-center rounded-md border text-xs"
                :class="
                  activeKey === s.key ? 'border-violet-400' : 'border-zinc-300 dark:border-zinc-700'
                "
                >{{ i + 1 }}</span
              >
              <span class="flex-1">{{ s.label }}</span>
              <span v-if="p && s.key === 'scripting'" class="text-[11px] text-zinc-400"
                >{{ p.scripted }}/{{ p.total }}</span
              >
              <span v-if="p && s.key === 'narration'" class="text-[11px] text-zinc-400"
                ><span v-if="p.stale" class="mr-1 text-amber-600">{{ p.stale }} stale</span
                >{{ p.narrated }}/{{ p.total }}</span
              >
              <span v-if="p && s.key === 'export'" class="text-[11px] text-zinc-400">{{
                p.exported
              }}</span>
            </RouterLink>
            <div v-else class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-400">
              <span
                class="grid h-6 w-6 place-items-center rounded-md border border-dashed border-zinc-300 text-xs dark:border-zinc-700"
                >{{ i + 1 }}</span
              >
              {{ s.label }}
            </div>
          </template>
        </nav>

        <div class="mx-2 mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <RouterLink
            to="/queue"
            class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
            :class="
              activeKey === 'queue' &&
              'bg-violet-50 font-semibold text-violet-700 dark:bg-violet-500/10 dark:text-violet-300'
            "
          >
            <span
              class="grid h-6 w-6 place-items-center rounded-md border border-zinc-300 text-xs dark:border-zinc-700"
              ><QueueIcon class="icon"
            /></span>
            <span class="flex-1">Queue</span>
            <span
              v-if="jobsStore.activeJobs.length"
              class="flex items-center gap-1 text-[11px] text-emerald-500"
              ><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500"></span
              >{{ jobsStore.activeJobs.length
              }}<span v-if="jobsStore.eta" class="text-zinc-400">
                · ~{{ Math.max(1, Math.round(jobsStore.eta.seconds / 60)) }}m</span
              ></span
            >
          </RouterLink>
          <RouterLink
            to="/endpoints"
            class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
            :class="
              activeKey === 'endpoints' &&
              'bg-violet-50 font-semibold text-violet-700 dark:bg-violet-500/10 dark:text-violet-300'
            "
          >
            <span
              class="grid h-6 w-6 place-items-center rounded-md border border-zinc-300 text-xs dark:border-zinc-700"
              ><EndpointsIcon class="icon"
            /></span>
            <span class="flex-1">Endpoints</span>
            <span
              v-if="endpointsNeedingAttention"
              class="text-[11px] text-amber-600 dark:text-amber-400"
              >{{ endpointsNeedingAttention }} to fix</span
            >
          </RouterLink>
        </div>

        <div
          v-if="libraryStore.book"
          class="mx-3 mt-5 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800"
        >
          <div class="label mb-1">Open book</div>
          <RouterLink
            :to="`/book/${libraryStore.book.id}`"
            class="block font-medium leading-snug hover:text-violet-500"
            :class="activeKey === 'overview' && 'text-violet-600 dark:text-violet-300'"
            >{{ libraryStore.book.title }}</RouterLink
          >
          <div class="text-zinc-500">{{ libraryStore.book.author }}</div>
          <div
            v-if="libraryStore.book.budget?.paused"
            class="mt-1 rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300"
          >
            <PauseIcon class="icon-sm icon-fill" /> paused ·
            <button class="underline" @click="libraryStore.resumeBook(libraryStore.book.id)">
              resume
            </button>
          </div>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <RouterLink
              :to="`/book/${libraryStore.book.id}`"
              class="rounded border border-zinc-200 px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              :class="activeKey === 'overview' && 'border-violet-400'"
              >Overview</RouterLink
            >
            <RouterLink
              :to="`/book/${libraryStore.book.id}/contents`"
              class="rounded border border-zinc-200 px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              :class="activeKey === 'contents' && 'border-violet-400'"
              >Contents
              <span
                v-if="libraryStore.contentsOf(libraryStore.book.id).skipped"
                class="text-zinc-400"
                >{{ libraryStore.contentsOf(libraryStore.book.id).included }}/{{
                  libraryStore.contentsOf(libraryStore.book.id).total
                }}</span
              ></RouterLink
            >
            <RouterLink
              :to="`/book/${libraryStore.book.id}/review`"
              class="rounded border border-zinc-200 px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              :class="[
                activeKey === 'review' && 'border-violet-400',
                waiting && 'border-amber-400 text-amber-700 dark:text-amber-300',
              ]"
              >Review <span v-if="waiting" class="font-medium">{{ waiting }}</span
              ><span v-else class="text-zinc-400">0</span></RouterLink
            >
            <RouterLink
              :to="`/book/${libraryStore.book.id}/cast`"
              class="rounded border border-zinc-200 px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              :class="activeKey === 'cast' && 'border-violet-400'"
              >Cast
              <span class="text-zinc-400">{{
                castStore.charactersOf(libraryStore.book.id).length
              }}</span></RouterLink
            >
            <RouterLink
              :to="`/book/${libraryStore.book.id}/search`"
              class="rounded border border-zinc-200 px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              :class="activeKey === 'search' && 'border-violet-400'"
              ><SearchIcon class="icon-sm" /> Search</RouterLink
            >
          </div>
        </div>

        <div class="mt-auto flex gap-2 p-3">
          <button class="btn-ghost flex-1 justify-center" @click="uiStore.dark = !uiStore.dark">
            <component :is="uiStore.dark ? SunIcon : MoonIcon" class="icon" />
            {{ uiStore.dark ? "Light" : "Dark" }}
          </button>
          <button class="btn-ghost" title="keyboard shortcuts (?)" @click="shortcuts = true">
            ?
          </button>
        </div>
      </aside>

      <div class="flex min-w-0 flex-1 flex-col">
        <header
          class="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-white px-3 sm:px-5 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <div class="flex min-w-0 items-center gap-2 text-sm text-zinc-500">
            <span class="lg:hidden"
              ><button class="btn-ghost btn-xs" aria-label="menu" @click="drawer = true">
                <MenuIcon class="icon" /></button
            ></span>
            <span class="capitalize text-zinc-900 dark:text-zinc-100">{{ activeKey }}</span>
            <span v-if="libraryStore.book" class="hidden truncate sm:inline">
              · {{ libraryStore.book.title }}</span
            >
          </div>
          <div class="flex items-center gap-2">
            <button
              class="flex items-center gap-2 rounded-md border border-zinc-200 px-2.5 py-1 text-xs text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
              @click="palette && (palette.open = true)"
            >
              <SearchIcon class="icon" /><span class="hidden sm:inline">Jump or run…</span>
              <kbd
                class="hidden rounded border border-zinc-200 px-1 font-mono text-[10px] sm:inline dark:border-zinc-700"
                >{{ modKey }} K</kbd
              >
            </button>
            <DemoTools />
            <JobIndicator />
          </div>
        </header>
        <CommandPalette ref="palette" />
        <ShortcutsDialog v-model:open="shortcuts" />
        <ExpressionReview />
        <main class="min-h-0 flex-1 overflow-auto">
          <!-- Stage views read `:bookId` once, at setup. Going from one book's stage straight to the
               same stage of another (the command palette, the Export demo) reuses the instance and
               would leave them pointed at the book you left, so the book id is the view's identity. -->
          <RouterView :key="String(route.params.bookId ?? '')" />
        </main>
      </div>
      <MiniPlayer />
      <Toasts />
    </div>
  </TooltipProvider>
</template>
