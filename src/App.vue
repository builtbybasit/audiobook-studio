<script setup lang="ts">
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useUiStore } from "@/stores/ui";

// App shell. Desktop: an icon rail on the left (AppRail; widens on request), the open book in the
// header — its selector in the top row (BookSelector), its pages and stages as a tab row under it
// (BookTabs). Narrow (< lg): a top bar with a menu button that opens the rail as a drawer, where
// the book's pages live instead of the tab row. Also hosts the palette, toasts, the shortcuts
// dialog, global ⌘Z / ? keys, the "book finished" notifications and the document title (active
// job count).
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { usePlayer } from "@/composables/usePlayer";
import JobIndicator from "@/components/JobIndicator.vue";
import CommandPalette from "@/components/CommandPalette.vue";
import DemoTools from "@/components/DemoTools.vue";
import {
  X as CloseIcon,
  Headphones as LogoIcon,
  Menu as MenuIcon,
  Moon as MoonIcon,
  Search as SearchIcon,
  Sun as SunIcon,
} from "@lucide/vue";
import Toasts from "@/components/Toasts.vue";
import MiniPlayer from "@/components/MiniPlayer.vue";
import ShortcutsDialog from "@/components/ShortcutsDialog.vue";
import ExpressionReview from "@/components/ExpressionReview.vue";
import AppRail from "@/components/AppRail.vue";
import BookSelector from "@/components/BookSelector.vue";
import BookTabs from "@/components/BookTabs.vue";
import { useShell } from "@/composables/useShell";
import { TooltipProvider } from "reka-ui";

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

const shell = useShell();
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
        class="fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-white transition-transform lg:static lg:translate-x-0 dark:border-zinc-800 dark:bg-zinc-900"
        :class="[
          drawer ? 'translate-x-0' : '-translate-x-full',
          uiStore.railExpanded ? 'lg:w-48' : 'lg:w-14',
        ]"
      >
        <div class="flex items-center gap-2 px-4 py-4" :class="!uiStore.railExpanded && 'lg:px-3'">
          <div
            class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-violet-600 text-white"
            title="Audiobook Studio · demo mode: seeded books and simulated jobs. No provider is called and every cost shown is simulated."
          >
            <LogoIcon class="icon-lg" />
          </div>
          <div class="leading-tight" :class="!uiStore.railExpanded && 'lg:hidden'">
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

        <AppRail />

        <div class="mt-auto flex gap-2 p-3" :class="!uiStore.railExpanded && 'lg:flex-col lg:p-2'">
          <button
            class="btn-ghost flex-1 justify-center"
            :title="uiStore.dark ? 'Light theme' : 'Dark theme'"
            @click="uiStore.dark = !uiStore.dark"
          >
            <component :is="uiStore.dark ? SunIcon : MoonIcon" class="icon" />
            <span :class="!uiStore.railExpanded && 'lg:hidden'">{{
              uiStore.dark ? "Light" : "Dark"
            }}</span>
          </button>
          <button
            class="btn-ghost justify-center"
            title="keyboard shortcuts (?)"
            @click="shortcuts = true"
          >
            ?
          </button>
        </div>
      </aside>

      <div class="flex min-w-0 flex-1 flex-col">
        <header
          class="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-white px-3 sm:px-5 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <div class="flex min-w-0 flex-1 items-center gap-2 text-sm text-zinc-500">
            <span class="lg:hidden"
              ><button class="btn-ghost btn-xs" aria-label="menu" @click="drawer = true">
                <MenuIcon class="icon" /></button
            ></span>
            <!-- the open book, or the page's name when there is none; on an app page the book
                 stays a click away but dimmed, so the header does not pretend you are on it -->
            <BookSelector v-if="shell.book.value" :dim="!shell.onBookPage.value" />
            <span v-else class="capitalize text-zinc-900 dark:text-zinc-100">{{
              shell.activeKey.value
            }}</span>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <button
              class="flex h-7 items-center gap-2 rounded-md border border-zinc-200 px-2.5 text-xs text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
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
        <BookTabs />
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
