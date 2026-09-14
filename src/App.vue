<script setup lang="ts">
// App shell. Desktop: fixed sidebar. Narrow (< lg): top bar with a menu button that opens the same
// sidebar as a drawer. Also hosts the palette, toasts, the shortcuts dialog, global ⌘Z / ? keys,
// the "book finished" notifications and the document title (active job count).
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useApp } from "@/stores/app";
import JobIndicator from "@/components/JobIndicator.vue";
import CommandPalette from "@/components/CommandPalette.vue";
import Toasts from "@/components/Toasts.vue";
import ShortcutsDialog from "@/components/ShortcutsDialog.vue";
import { TooltipProvider } from "reka-ui";

const app = useApp();
const route = useRoute();
const drawer = ref(false);
const shortcuts = ref(false);

watch(
  () => route.params.bookId,
  (id) => {
    if (id) app.currentBookId = String(id);
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
  () => app.dark,
  (d) => document.documentElement.classList.toggle("dark", d),
  { immediate: true },
);
watch(
  () => app.activeJobs.length,
  (n) => {
    document.title = (n ? `(${n}) ` : "") + "Audiobook Studio · prototype";
  },
  { immediate: true },
);

// a book's run finished (it had active jobs, now none) → toast, and a browser notification if enabled
const activeByBook = computed(() => {
  const m: Record<string, number> = {};
  for (const j of app.activeJobs) m[j.bookId] = (m[j.bookId] ?? 0) + 1;
  return m;
});
watch(activeByBook, (now, before) => {
  for (const id of Object.keys(before ?? {})) {
    if (now[id]) continue;
    const b = app.bookById(id);
    if (!b) continue;
    const recent = app.jobs.filter(
      (j) => j.bookId === id && j.finishedAt && Date.now() - j.finishedAt < 5 * 60000,
    );
    const failed = recent.filter((j) => j.status === "failed").length;
    const cancelled = recent.filter((j) => j.status === "cancelled").length;
    if (recent.length && recent.every((j) => j.status === "cancelled")) continue;
    const desc = `${recent.length - failed - cancelled} done${failed ? ` · ${failed} failed` : ""}`;
    app.toast(`${b.title}: run finished`, {
      kind: failed ? "warn" : "success",
      description: desc,
      action: {
        label: failed ? "See what failed" : "Open queue",
        run: () => router.push("/queue"),
      },
    });
    if (
      app.notify &&
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
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
    if (app.undoLast()) e.preventDefault();
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

const stages: { key: string; label: string; icon: string; to: (b: string | null) => string }[] = [
  { key: "library", label: "Library", icon: "▤", to: () => "/library" },
  { key: "scripting", label: "Scripting", icon: "✎", to: (b) => `/book/${b}/scripting` },
  { key: "narration", label: "Narration", icon: "♪", to: (b) => `/book/${b}/narration` },
  { key: "export", label: "Export", icon: "⤓", to: (b) => `/book/${b}/export` },
];
const activeKey = computed(() =>
  route.path.match(/^\/book\/[^/]+$/) ? "overview" : route.path.split("/").pop(),
);
const p = computed(() => (app.currentBookId ? app.progress(app.currentBookId) : null));
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
          <div class="grid h-8 w-8 place-items-center rounded-lg bg-violet-600 text-white">◍</div>
          <div class="leading-tight">
            <div class="font-semibold">Audiobook Studio</div>
            <div class="text-[10px] uppercase tracking-wider text-amber-500">prototype</div>
          </div>
          <button class="ml-auto text-zinc-400 lg:hidden" @click="drawer = false">✕</button>
        </div>

        <nav class="mt-2 flex flex-col gap-0.5 px-2">
          <template v-for="(s, i) in stages" :key="s.key">
            <RouterLink
              v-if="s.key === 'library' || app.currentBookId"
              :to="s.to(app.currentBookId)"
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
              >≡</span
            >
            <span class="flex-1">Queue</span>
            <span
              v-if="app.activeJobs.length"
              class="flex items-center gap-1 text-[11px] text-emerald-500"
              ><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500"></span
              >{{ app.activeJobs.length
              }}<span v-if="app.eta" class="text-zinc-400">
                · ~{{ Math.max(1, Math.round(app.eta.seconds / 60)) }}m</span
              ></span
            >
          </RouterLink>
        </div>

        <div
          v-if="app.book"
          class="mx-3 mt-5 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800"
        >
          <div class="label mb-1">Open book</div>
          <RouterLink
            :to="`/book/${app.book.id}`"
            class="block font-medium leading-snug hover:text-violet-500"
            :class="activeKey === 'overview' && 'text-violet-600 dark:text-violet-300'"
            >{{ app.book.title }}</RouterLink
          >
          <div class="text-zinc-500">{{ app.book.author }}</div>
          <div
            v-if="app.book.budget?.paused"
            class="mt-1 rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300"
          >
            ❚❚ paused ·
            <button class="underline" @click="app.resumeBook(app.book.id)">resume</button>
          </div>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <RouterLink
              :to="`/book/${app.book.id}`"
              class="rounded border border-zinc-200 px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              :class="activeKey === 'overview' && 'border-violet-400'"
              >Overview</RouterLink
            >
            <RouterLink
              :to="`/book/${app.book.id}/cast`"
              class="rounded border border-zinc-200 px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              :class="activeKey === 'cast' && 'border-violet-400'"
              >Cast
              <span class="text-zinc-400">{{
                app.charactersOf(app.book.id).length
              }}</span></RouterLink
            >
            <RouterLink
              :to="`/book/${app.book.id}/search`"
              class="rounded border border-zinc-200 px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              :class="activeKey === 'search' && 'border-violet-400'"
              >⌕ Search</RouterLink
            >
          </div>
        </div>

        <div class="mt-auto flex gap-2 p-3">
          <button class="btn-ghost flex-1 justify-center" @click="app.dark = !app.dark">
            {{ app.dark ? "☀ Light" : "☾ Dark" }}
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
                ☰
              </button></span
            >
            <span class="capitalize text-zinc-900 dark:text-zinc-100">{{ activeKey }}</span>
            <span v-if="app.book" class="hidden truncate sm:inline"> · {{ app.book.title }}</span>
          </div>
          <div class="flex items-center gap-2">
            <button
              class="flex items-center gap-2 rounded-md border border-zinc-200 px-2.5 py-1 text-xs text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
              @click="palette && (palette.open = true)"
            >
              ⌕<span class="hidden sm:inline"> Jump or run…</span>
              <kbd
                class="hidden rounded border border-zinc-200 px-1 font-mono text-[10px] sm:inline dark:border-zinc-700"
                >{{ modKey }} K</kbd
              >
            </button>
            <JobIndicator />
          </div>
        </header>
        <CommandPalette ref="palette" />
        <ShortcutsDialog v-model:open="shortcuts" />
        <main class="min-h-0 flex-1 overflow-auto">
          <RouterView />
        </main>
      </div>
      <Toasts />
    </div>
  </TooltipProvider>
</template>
