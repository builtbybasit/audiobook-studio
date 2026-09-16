<script setup lang="ts">
// The Demo drawer. Prototype only, and the one place the seeded situations are driven from.
//
// It is a workbench rather than a menu, so it is a non-modal panel down the right of the page:
// picking a row leaves it open so the page can be watched reacting, and it keeps its scroll. Top
// to bottom: the situation the world is in now, with what applying it did and what to try; the
// seeded rows that belong to the page that is open; every situation, grouped; and the simulation
// switches with Reset, which says what it will drop before it is pressed.
import { useDemoStore } from "@/stores/demo";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";

import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { usePlayer } from "@/composables/usePlayer";
import { DEMO_GROUPS, SPEEDS } from "@/mock";
import { UiSwitch, UiToggleGroup } from "@/ui";
import {
  ArrowUpRight as OpenIcon,
  FlaskConical as DemoIcon,
  RotateCcw as ResetIcon,
  Search as SearchIcon,
  Undo2 as RestoreIcon,
  X as CloseIcon,
} from "@lucide/vue";
import type { DemoScenario, SearchScenario } from "@/types";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const demoStore = useDemoStore();
const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();
const player = usePlayer();
const route = useRoute();
const router = useRouter();
const panel = ref<HTMLElement | null>(null);

const active = computed(() => demoStore.activeScenario);
const speedHint = computed(
  () => SPEEDS.find((s) => s.value === demoStore._speed)?.hint ?? `${demoStore._speed}×`,
);
const groups = computed(() =>
  DEMO_GROUPS.map((g) => ({
    ...g,
    rows: demoStore.scenarios.filter((s) => s.group === g.id),
  })).filter((g) => g.rows.length),
);
/** a row that opens on the page that is open now */
const here = (s: DemoScenario) => s.path.split("?")[0] === route.path;

// ---- the page that is open. The seeded searches are queries against the seeded book rather than
// situations, so they belong with the Search page and appear only while it is open.
const bookId = computed(() => String(route.params.bookId ?? "") || null);
const onSearch = computed(() => !!bookId.value && route.path.endsWith("/search"));
const searchRows = computed(() =>
  onSearch.value && bookId.value ? demoStore.searchScenarios(bookId.value) : [],
);
const searchSeeded = computed(
  () => !!bookId.value && demoStore._searchDemo?.bookId === bookId.value,
);
const bookTitle = computed(() =>
  bookId.value ? (libraryStore.bookById(bookId.value)?.title ?? "this book") : "",
);

// ---- what a reset reaches, said before it is pressed
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const imported = computed(
  () => libraryStore.books.filter((b) => !demoStore.survivesReset(b.id)).length,
);
const running = computed(() => jobsStore.activeJobs.length);
const resetLine = computed(() => {
  const drops: string[] = [];
  if (imported.value)
    drops.push(count(imported.value, "book added this session", "books added this session"));
  if (running.value) drops.push(count(running.value, "run in flight", "runs in flight"));
  return drops.length
    ? `Drops ${drops.join(" and ")}.`
    : "Nothing is running or added this session.";
});
const leavesPage = computed(() => !!bookId.value && !demoStore.survivesReset(bookId.value));

/** On a phone the drawer is the whole screen, so a pick has to get out of the page's way. */
const narrow = () => window.matchMedia("(max-width: 639px)").matches;

/**
 * A book imported during the session is not in the seeded world, so restoring it takes the book out
 * from under whatever page is open on it. Leave first and wait for the route to change: a stage view
 * reads its book straight out of the store, and would render once against a book that had gone.
 */
async function leaveIfBookGoes() {
  if (leavesPage.value) await router.push("/library");
}
async function pick(s: DemoScenario) {
  player.stop(); // it is timing clips from a world that is about to be replaced
  await leaveIfBookGoes();
  const to = demoStore.applyScenario(s.id);
  if (narrow()) emit("close");
  if (to) await router.push(to);
  // the applied row is now described at the top of the drawer
  await nextTick();
  panel.value?.querySelector("[data-scroll]")?.scrollTo({ top: 0, behavior: "smooth" });
}
function openPage() {
  if (active.value) void router.push(active.value.path);
}
async function reset() {
  player.stop();
  await leaveIfBookGoes();
  demoStore.resetDemo();
}
function pickSearch(s: SearchScenario) {
  if (!bookId.value) return;
  demoStore.seedSearchDemo(bookId.value);
  if (narrow()) emit("close");
  void router.push({
    path: `/book/${bookId.value}/search`,
    query: {
      q: s.query,
      speaker: s.speaker || undefined,
      type: s.type === "all" ? undefined : s.type,
    },
  });
}

// focus goes in when it opens; Esc closes from anywhere inside it. The root class lets the toast
// stack step aside from the drawer (toasts.css) rather than land on top of it.
watch(
  () => props.open,
  async (v) => {
    document.documentElement.classList.toggle("demo-drawer-open", v);
    if (!v) return;
    await nextTick();
    panel.value?.querySelector<HTMLElement>("[data-close]")?.focus();
  },
  { immediate: true },
);
onUnmounted(() => document.documentElement.classList.remove("demo-drawer-open"));
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    emit("close");
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-transform duration-200 ease-out"
      enter-from-class="translate-x-full"
      leave-active-class="transition-transform duration-150 ease-in"
      leave-to-class="translate-x-full"
    >
      <!-- role=dialog keeps the reader's and the shelf's single-key shortcuts out of it; it is not
           modal, because the point is to watch the page change while it stays open -->
      <aside
        v-if="open"
        id="demo-drawer"
        ref="panel"
        role="dialog"
        aria-modal="false"
        aria-label="Demo tools"
        class="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-zinc-200 bg-white text-xs shadow-2xl sm:w-[400px] dark:border-zinc-800 dark:bg-zinc-950"
        @keydown="onKey"
      >
        <header
          class="flex shrink-0 items-start gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800"
        >
          <div class="min-w-0 flex-1">
            <div class="label flex items-center gap-1.5">
              <DemoIcon class="icon-sm" /> Demo mode
            </div>
            <p class="mt-0.5 leading-relaxed text-zinc-500">
              Seeded books, simulated jobs, invented costs. A row is always applied to the seeded
              world, so the same row gives the same situation every time.
            </p>
          </div>
          <button
            data-close
            class="icon-btn shrink-0"
            aria-label="Close the demo tools"
            @click="emit('close')"
          >
            <CloseIcon class="icon-sm" />
          </button>
        </header>

        <div data-scroll class="min-h-0 flex-1 overflow-y-auto">
          <!-- where the world is now -->
          <section
            class="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800"
            :class="active && 'bg-violet-50/60 dark:bg-violet-500/5'"
            aria-live="polite"
          >
            <div class="label mb-1">Now</div>
            <template v-if="active">
              <div class="text-sm font-medium">{{ active.name }}</div>
              <p
                v-if="demoStore._note"
                class="mt-1 leading-relaxed text-zinc-600 dark:text-zinc-300"
              >
                {{ demoStore._note }}
              </p>
              <ol v-if="active.steps?.length" class="mt-2 space-y-1">
                <li v-for="(step, i) in active.steps" :key="i" class="flex gap-2 leading-relaxed">
                  <span
                    class="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-violet-600 text-[10px] text-white"
                    >{{ i + 1 }}</span
                  ><span>{{ step }}</span>
                </li>
              </ol>
              <div class="mt-2 flex flex-wrap gap-1.5">
                <button v-if="!here(active)" class="btn-ghost btn-xs" @click="openPage">
                  <OpenIcon class="icon-sm" /> Open its page
                </button>
                <button class="btn-ghost btn-xs" @click="reset">
                  <ResetIcon class="icon-sm" /> Reset
                </button>
              </div>
            </template>
            <template v-else>
              <div class="text-sm font-medium">The seeded world</div>
              <p class="mt-1 leading-relaxed text-zinc-500">
                Nothing applied: four books at different points, a queue with a few runs going, and
                every endpoint on a demo key. Pick a situation below.
              </p>
            </template>
          </section>

          <!-- what belongs to the page that is open -->
          <section v-if="onSearch" class="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <div class="label mb-1 flex items-center gap-1.5">
              <SearchIcon class="icon-sm" /> On this page · seeded searches
            </div>
            <p class="mb-2 leading-relaxed text-zinc-500">
              Queries against {{ bookTitle }} as it is seeded, for the bulk corrections. Picking one
              seeds the book in memory once and runs the search.
            </p>
            <p v-if="!searchRows.length" class="text-zinc-500">
              Script a chapter of this book first.
            </p>
            <button
              v-for="s in searchRows"
              :key="s.id"
              class="mb-1 block w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-left transition-colors hover:border-violet-400 dark:border-zinc-800 dark:hover:border-violet-500"
              @click="pickSearch(s)"
            >
              <span class="font-medium">{{ s.label }}</span>
              <span class="block leading-relaxed text-zinc-500">{{ s.hint }}</span>
            </button>
            <button
              v-if="searchSeeded"
              class="btn-ghost btn-xs mt-1"
              @click="demoStore.resetSearchDemo()"
            >
              <RestoreIcon class="icon-sm" /> Put the book back
            </button>
          </section>

          <!-- every situation -->
          <section class="px-4 py-3">
            <div class="label mb-2">Situations</div>
            <div
              v-for="g in groups"
              :key="g.id"
              role="group"
              :aria-labelledby="`demo-${g.id}`"
              class="mb-3 last:mb-0"
            >
              <div
                :id="`demo-${g.id}`"
                class="mb-1 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300"
              >
                {{ g.label }}
              </div>
              <button
                v-for="s in g.rows"
                :key="s.id"
                class="group mb-1 block w-full rounded-md border px-2.5 py-1.5 text-left transition-colors"
                :class="
                  active?.id === s.id
                    ? 'border-violet-400 bg-violet-500/10 dark:border-violet-500'
                    : 'border-zinc-200 hover:border-violet-400 dark:border-zinc-800 dark:hover:border-violet-500'
                "
                :aria-current="active?.id === s.id ? 'true' : undefined"
                @click="pick(s)"
              >
                <span class="flex items-center gap-2">
                  <span class="min-w-0 flex-1 truncate font-medium">{{ s.name }}</span>
                  <span
                    v-if="active?.id === s.id"
                    class="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-violet-600 dark:text-violet-300"
                    >applied</span
                  >
                  <span v-else-if="here(s)" class="shrink-0 text-[10px] text-zinc-400"
                    >opens here</span
                  >
                </span>
                <!-- one line each, the whole blurb on the row under the pointer or the keyboard -->
                <span
                  class="leading-relaxed text-zinc-500 group-hover:line-clamp-none group-focus-visible:line-clamp-none"
                  :class="active?.id === s.id ? 'line-clamp-none' : 'line-clamp-1'"
                  >{{ s.blurb }}</span
                >
              </button>
            </div>
          </section>
        </div>

        <footer class="shrink-0 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div class="label mb-1">Simulation</div>
          <div class="flex flex-wrap items-center gap-2">
            <span id="demo-speed">Simulated jobs run at</span>
            <UiToggleGroup
              :model-value="demoStore._speed"
              :options="SPEEDS.map((s) => ({ value: s.value, label: s.label }))"
              aria-labelledby="demo-speed"
              @update:model-value="(v) => demoStore.setSpeed(Number(v))"
            />
            <span class="text-zinc-500">{{ speedHint }}</span>
          </div>
          <p class="mb-2 mt-0.5 leading-relaxed text-zinc-500">
            Shortens every simulated wait. A run already going picks it up at its next request; the
            latency and cost a request records stay as they would be at 1×.
          </p>
          <UiSwitch v-model="demoStore._exportFails" label="make the next build fail" />
          <p class="mt-0.5 leading-relaxed text-zinc-500">
            One shot. The build stops part-way, the version on disk stays, and the failure offers a
            retry.
          </p>
          <div class="mt-3 flex items-start gap-2">
            <button class="btn-ghost btn-xs shrink-0" @click="reset">
              <ResetIcon class="icon-sm" /> Reset the demo data
            </button>
            <p class="leading-relaxed text-zinc-500">
              Puts every book, script, voice, job and export back. {{ resetLine
              }}<template v-if="leavesPage">
                This page is on a book the reset drops, so it goes back to the Library
                first.</template
              >
            </p>
          </div>
        </footer>
      </aside>
    </Transition>
  </Teleport>
</template>
