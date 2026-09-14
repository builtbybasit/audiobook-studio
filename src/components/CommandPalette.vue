<script setup lang="ts">
// ⌘K / Ctrl+K command palette: reka Dialog + Listbox with a filter. Jump to any page, book, chapter,
// speaker or endpoint, or run the common actions (script pending, narrate, retry failed, toggle theme…).
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { RouteLocationRaw } from "vue-router";
import { useApp, isScripted, isNarrated } from "@/stores/app";
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  ListboxContent,
  ListboxFilter,
  ListboxGroup,
  ListboxGroupLabel,
  ListboxItem,
  ListboxRoot,
  useFilter,
} from "reka-ui";

const app = useApp();
const router = useRouter();
const route = useRoute();
const open = ref(false);
const q = ref("");
const content = ref<{ $el?: HTMLElement } | null>(null);
const { contains } = useFilter({ sensitivity: "base" });
const isMac = /Mac|iPhone/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl";

function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    open.value = !open.value;
  }
}
onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));
watch(open, (o) => {
  if (o) q.value = "";
});

const bookId = computed(() => app.currentBookId);
const book = computed(() => app.book);
const chs = computed(() => (bookId.value ? app.chaptersOf(bookId.value) : []));
const go = (to: RouteLocationRaw) => () => router.push(to);

/** One row of the palette; the default order is the order they are pushed. */
interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  /** speaker swatch, on Speakers rows */
  color?: string;
  run: () => void;
}
const commands = computed(() => {
  const out: Command[] = [];
  const b = bookId.value;
  out.push({
    id: "nav-library",
    group: "Go to",
    label: "Library",
    hint: "all novels",
    run: go("/library"),
  });
  out.push({
    id: "nav-queue",
    group: "Go to",
    label: "Queue",
    hint: `${app.activeJobs.length} active`,
    run: go("/queue"),
  });
  if (b) {
    out.push({
      id: "nav-overview",
      group: "Go to",
      label: `Overview · ${book.value!.title}`,
      run: go(`/book/${b}`),
    });
    out.push({
      id: "nav-cast",
      group: "Go to",
      label: "Cast",
      hint: `${app.charactersOf(b).length} speakers`,
      run: go(`/book/${b}/cast`),
    });
    out.push({
      id: "nav-scripting",
      group: "Go to",
      label: "Scripting",
      hint: "stage 1",
      run: go(`/book/${b}/scripting`),
    });
    out.push({
      id: "nav-narration",
      group: "Go to",
      label: "Narration",
      hint: "stage 2",
      run: go(`/book/${b}/narration`),
    });
    out.push({
      id: "nav-export",
      group: "Go to",
      label: "Export",
      hint: "stage 3",
      run: go(`/book/${b}/export`),
    });
  }
  // actions on the open book
  if (b) {
    const pending = chs.value
      .filter((c) => !isScripted(c) && !["running", "queued"].includes(c.scripting))
      .map((c) => c.id);
    const scripted = chs.value
      .filter(
        (c) => isScripted(c) && !isNarrated(c) && !["running", "queued"].includes(c.narration),
      )
      .map((c) => c.id);
    const stale = chs.value.filter((c) => c.narration === "stale");
    const failedN = chs.value.filter((c) => c.narration === "failed");
    if (pending.length)
      out.push({
        id: "act-script",
        group: "Actions",
        label: `Script all pending chapters`,
        hint: `${pending.length} ch`,
        keywords: "extract run",
        run: () => {
          app.runScripting(b, pending);
          router.push(`/book/${b}/scripting`);
        },
      });
    if (scripted.length)
      out.push({
        id: "act-narrate",
        group: "Actions",
        label: `Narrate all scripted chapters`,
        hint: `${scripted.length} ch`,
        keywords: "tts render run",
        run: () => {
          app.runNarration(b, scripted);
          router.push(`/book/${b}/narration`);
        },
      });
    if (stale.length)
      out.push({
        id: "act-stale",
        group: "Actions",
        label: `Re-narrate changed segments`,
        hint: `${stale.length} ch stale`,
        keywords: "edited",
        run: () => {
          stale.forEach((c) => app.renarrateStale(b, c.id));
          router.push(`/book/${b}/narration`);
        },
      });
    if (failedN.length)
      out.push({
        id: "act-retry-ch",
        group: "Actions",
        label: `Retry failed narration`,
        hint: `${failedN.length} ch`,
        run: () => {
          failedN.forEach((c) => app.retryFailed(b, c.id));
          router.push(`/book/${b}/narration`);
        },
      });
    if (app.charactersOf(b).some((c) => !c.voice && c.name !== "Narrator"))
      out.push({
        id: "act-auto",
        group: "Actions",
        label: "Auto-assign voices by gender",
        hint: "unvoiced cast",
        run: () => {
          app.autoAssignByGender(b);
          router.push(`/book/${b}/narration`);
        },
      });
    if (app.mergeSuggestions(b).length)
      out.push({
        id: "act-merge",
        group: "Actions",
        label: "Review merge suggestions",
        hint: `${app.mergeSuggestions(b).length}`,
        keywords: "alias duplicate cast",
        run: go(`/book/${b}/cast`),
      });
  }
  if (app.jobs.some((j) => j.status === "failed"))
    out.push({
      id: "act-retry-all",
      group: "Actions",
      label: "Retry all failed jobs",
      hint: `${app.jobs.filter((j) => j.status === "failed").length}`,
      keywords: "queue",
      run: () => app.retryAllFailed(),
    });
  if (app.activeJobs.length)
    out.push({
      id: "act-cancel-all",
      group: "Actions",
      label: "Cancel all running and queued jobs",
      hint: `${app.activeJobs.length}`,
      keywords: "stop queue",
      run: () => app.cancelAll(),
    });
  out.push({
    id: "act-endpoint",
    group: "Actions",
    label: "Add TTS endpoint",
    keywords: "server voice api",
    run: () => {
      app.addEndpoint();
      if (b) router.push(`/book/${b}/narration`);
    },
  });
  out.push({
    id: "act-dark",
    group: "Actions",
    label: app.dark ? "Switch to light theme" : "Switch to dark theme",
    keywords: "dark light mode theme",
    run: () => {
      app.dark = !app.dark;
    },
  });
  out.push({
    id: "act-keys",
    group: "Actions",
    label: "Keyboard shortcuts",
    hint: "?",
    keywords: "help keys hotkeys",
    run: () => window.dispatchEvent(new CustomEvent("open-shortcuts")),
  });
  if (b && app._undo.length)
    out.push({
      id: "act-undo",
      group: "Actions",
      label: `Undo: ${app._undo.at(-1)!.label}`,
      hint: `${mod} Z`,
      run: () => app.undoLast(),
    });
  if (b)
    out.push({
      id: "act-pause",
      group: "Actions",
      label: book.value!.budget?.paused
        ? `Resume ${book.value!.title}`
        : `Pause everything on ${book.value!.title}`,
      keywords: "budget stop",
      run: () => (book.value!.budget?.paused ? app.resumeBook(b) : app.pauseBook(b)),
    });
  // books
  for (const bk of app.books)
    if (bk.id !== b)
      out.push({
        id: "book-" + bk.id,
        group: "Novels",
        label: bk.title,
        hint: `${bk.author} · ${app.chaptersOf(bk.id).length} ch`,
        keywords: bk.author,
        run: go(`/book/${bk.id}`),
      });
  // chapters of the open book → the stage they're at
  for (const c of chs.value) {
    const stage = isNarrated(c) || c.narration !== "none" ? "narration" : "scripting";
    const state =
      c.narration !== "none"
        ? c.narration
        : c.scripting !== "none"
          ? `scripting ${c.scripting}`
          : "not scripted";
    out.push({
      id: "ch-" + c.id,
      group: "Chapters",
      label: `${String(c.id).padStart(2, "0")} · ${c.title}`,
      hint: state,
      keywords: `chapter ${c.id} ${app.volumeOf(b!, c.id)?.name ?? ""}`,
      run: go({ path: `/book/${b}/${stage}`, query: { ch: c.id } }),
    });
  }
  // speakers of the open book
  if (b)
    for (const c of app.charactersOf(b))
      out.push({
        id: "sp-" + c.name,
        group: "Speakers",
        label: c.name,
        hint: c.voice ? app.voiceLabel(c.voice) : "Narrator’s voice",
        color: c.color,
        keywords: `speaker cast ${c.aliases.join(" ")}`,
        run: go(`/book/${b}/cast`),
      });
  // endpoints
  for (const e of app.endpoints)
    out.push({
      id: "ep-" + e.id,
      group: "Endpoints",
      label: `${e.enabled ? "Pause" : "Resume"} ${e.name}`,
      hint: `${e.voices.length} voices · ${e.enabled ? "on" : "paused"}`,
      keywords: "endpoint tts server",
      run: () => {
        e.enabled = !e.enabled;
      },
    });
  return out;
});
const filtered = computed(() => {
  const s = q.value.trim();
  const search =
    s.length >= 2 && bookId.value
      ? [
          {
            id: "search",
            group: "Search",
            label: `Search the script for “${s}”`,
            hint: "text · speaker · direction",
            run: go({ path: `/book/${bookId.value}/search`, query: { q: s } }),
          },
        ]
      : [];
  const list = s
    ? [
        ...search,
        ...commands.value.filter(
          (c) =>
            contains(c.label, s) ||
            contains(c.keywords ?? "", s) ||
            contains(c.group, s) ||
            (c.hint && contains(c.hint, s)),
        ),
      ]
    : commands.value;
  // without a query keep it short: nav + actions + a few of each big group
  const cap = s ? 40 : 8;
  const seen: Record<string, number> = {};
  return list.filter(
    (c) =>
      (seen[c.group] = (seen[c.group] ?? 0) + 1) <=
      (s ? cap : c.group === "Go to" || c.group === "Actions" ? 99 : cap),
  );
});
const groups = computed(() => {
  const m = new Map<string, Command[]>();
  for (const c of filtered.value) {
    if (!m.has(c.group)) m.set(c.group, []);
    m.get(c.group)!.push(c);
  }
  return [...m.entries()];
});

function run(id: string) {
  const c = filtered.value.find((c) => c.id === id) ?? commands.value.find((c) => c.id === id);
  if (!c) return;
  open.value = false;
  nextTick(() => c.run());
}
function onFilterKey(e: KeyboardEvent) {
  if (e.key === "Enter" && !content.value?.$el?.querySelector("[data-highlighted]")) {
    e.preventDefault();
    if (filtered.value[0]) run(filtered.value[0].id);
  }
}
defineExpose({ open });
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px]" />
      <DialogContent
        class="fixed left-1/2 top-[12vh] z-50 w-[min(640px,92vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
        @open-auto-focus.prevent
      >
        <DialogTitle class="sr-only">Command palette</DialogTitle>
        <DialogDescription class="sr-only"
          >Jump anywhere or run an action. Type to filter, arrows to move, Enter to
          run.</DialogDescription
        >
        <ListboxRoot
          :model-value="undefined"
          highlight-on-hover
          @update:model-value="(v) => run(String(v))"
        >
          <div class="flex items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
            <span class="text-zinc-400">⌕</span>
            <ListboxFilter
              v-model="q"
              auto-focus
              class="h-12 min-w-0 flex-1 bg-transparent text-sm focus:outline-none"
              placeholder="Jump to a page, chapter, speaker… or run an action"
              @keydown="onFilterKey"
            />
            <kbd
              class="rounded border border-zinc-200 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 dark:border-zinc-700"
              >esc</kbd
            >
          </div>
          <ListboxContent ref="content" class="max-h-[60vh] overflow-auto p-1.5">
            <ListboxGroup v-for="[g, items] in groups" :key="g" class="mb-1">
              <ListboxGroupLabel
                class="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400"
                >{{ g }}</ListboxGroupLabel
              >
              <ListboxItem
                v-for="c in items"
                :key="c.id"
                :value="c.id"
                class="ui-item py-1.5"
                @select="run(c.id)"
              >
                <span
                  v-if="c.color"
                  class="mr-2 inline-block h-2 w-2 shrink-0 rounded-full"
                  :style="{ background: c.color }"
                ></span>
                <span class="min-w-0 flex-1 truncate">{{ c.label }}</span>
                <span v-if="c.hint" class="ml-3 shrink-0 text-[11px] text-zinc-400">{{
                  c.hint
                }}</span>
              </ListboxItem>
            </ListboxGroup>
            <div v-if="!filtered.length" class="p-6 text-center text-sm text-zinc-500">
              Nothing matches “{{ q }}”.
            </div>
          </ListboxContent>
          <div
            class="flex items-center gap-3 border-t border-zinc-200 px-3 py-1.5 text-[10px] text-zinc-400 dark:border-zinc-800"
          >
            <span><kbd class="font-mono">↑↓</kbd> move</span
            ><span><kbd class="font-mono">↵</kbd> run</span
            ><span><kbd class="font-mono">esc</kbd> close</span>
            <span class="ml-auto">{{ filtered.length }} of {{ commands.length }}</span>
          </div>
        </ListboxRoot>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
