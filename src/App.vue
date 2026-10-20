<script setup lang="ts">
import { useUiStore } from "@/stores/ui";

// App shell: icon rail (a drawer below lg), header with the open book's selector, book tabs, and
// the global ⌘Z / ? keys. What runs behind every page is `useAppEffects`.
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useAppEffects } from "@/composables/useAppEffects";
import { usePlayer } from "@/composables/usePlayer";
import JobIndicator from "@/components/JobIndicator.vue";
import CommandPalette from "@/components/CommandPalette.vue";
import DemoTools from "@/components/DemoTools.vue";
import {
  X as CloseIcon,
  Headphones as LogoIcon,
  Image as CoversIcon,
  ImageOff as NoCoversIcon,
  Menu as MenuIcon,
  Moon as MoonIcon,
  Search as SearchIcon,
  Sun as SunIcon,
} from "@lucide/vue";
import Toasts from "@/components/Toasts.vue";
import MiniPlayer from "@/components/MiniPlayer.vue";
import ShortcutsDialog from "@/components/ShortcutsDialog.vue";
import ExistingLinesDialog from "@/views/cast/ExistingLinesDialog.vue";
import VoiceSpeedDialog from "@/views/cast/VoiceSpeedDialog.vue";
import AppRail from "@/components/AppRail.vue";
import BookSelector from "@/components/BookSelector.vue";
import BookTabs from "@/components/BookTabs.vue";
import { useShell } from "@/composables/useShell";
import { modKey } from "@/lib/format";
import { isDemo } from "@/services/mode";
import { TooltipProvider } from "reka-ui";
import { UiTipLayer } from "@/ui";
import { showCovers } from "@/views/library/shared";

const uiStore = useUiStore();
const player = usePlayer();
const route = useRoute();
const drawer = ref(false);
const shortcuts = ref(false);
useAppEffects();

watch(
  () => route.fullPath,
  () => {
    drawer.value = false;
  },
);

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
            :data-tip="
              isDemo
                ? 'Audiobook Studio · demo mode: a demo library on the server, on simulated endpoints. No provider is called and nothing is billed.'
                : 'Audiobook Studio'
            "
          >
            <LogoIcon class="icon-lg" />
          </div>
          <div class="leading-tight" :class="!uiStore.railExpanded && 'lg:hidden'">
            <div class="font-semibold">Audiobook Studio</div>
            <!-- the demo's endpoints are simulated; say so where the name is -->
            <div
              v-if="isDemo"
              class="text-[10px] uppercase tracking-wider text-amber-500"
              data-tip="A demo library on the server, seeded with books and on simulated endpoints. No provider is called and nothing is billed."
            >
              demo library · nothing billed
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
            :data-tip="uiStore.dark ? 'Light theme' : 'Dark theme'"
            @click="uiStore.dark = !uiStore.dark"
          >
            <component :is="uiStore.dark ? SunIcon : MoonIcon" class="icon" />
            <span :class="!uiStore.railExpanded && 'lg:hidden'">{{
              uiStore.dark ? "Light" : "Dark"
            }}</span>
          </button>
          <button
            class="btn-ghost justify-center"
            data-tip="keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
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
            <!-- on an app page the book stays a click away but dimmed -->
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
            <button
              class="btn-ghost btn-xs"
              :data-tip="showCovers ? 'Hide book covers' : 'Show book covers'"
              :aria-pressed="showCovers"
              @click="showCovers = !showCovers"
            >
              <component :is="showCovers ? NoCoversIcon : CoversIcon" class="icon" />
            </button>
            <DemoTools />
            <JobIndicator />
          </div>
        </header>
        <BookTabs />
        <CommandPalette ref="palette" />
        <ShortcutsDialog v-model:open="shortcuts" />
        <ExistingLinesDialog />
        <VoiceSpeedDialog />
        <main class="relative min-h-0 flex-1 overflow-auto">
          <!-- Stage views read `:bookId` once at setup; keying on it stops a same-stage jump to
               another book from reusing the instance pointed at the old book. -->
          <RouterView :key="String(route.params.bookId ?? '')" />
        </main>
      </div>
      <MiniPlayer />
      <Toasts />
    </div>
    <UiTipLayer />
  </TooltipProvider>
</template>
