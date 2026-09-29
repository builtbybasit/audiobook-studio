<script setup lang="ts">
// The Demo drawer: the way into the demo and out of it, and in the demo the one place the seeded
// situations are driven from.
//
// On your own library it says what the demo is and offers to open it; nothing else here means
// anything outside the demo, so nothing else shows. Entering and leaving load the page again on the
// other library (services/mode.ts) rather than swapping worlds under the open page.
//
// In the demo it is a workbench rather than a menu, so it is a non-modal panel down the right of
// the page. The demo is a library of its own on the server (`server/routes/demo.ts`): picking a row
// seeds it again with that situation, and the page loads on where the situation is to be looked
// at, with the drawer open again beside it. Top to bottom: the situation the demo is in now, with
// what applying it did and what to try; every situation, grouped; and the speed, Reset — which
// says what it will drop before it is pressed — and the way out.
import { useDemoStore } from "@/stores/demo";
import { useJobsStore } from "@/stores/jobs";

import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { usePlayer } from "@/composables/usePlayer";
import { SPEEDS } from "@/lib/demoSpeed";
import { enterDemo, isDemo, leaveDemo } from "@/services/mode";
import { UiToggleGroup } from "@/ui";
import {
  ArrowUpRight as OpenIcon,
  FlaskConical as DemoIcon,
  LogIn as EnterIcon,
  LogOut as LeaveIcon,
  RotateCcw as ResetIcon,
  X as CloseIcon,
} from "@lucide/vue";
import type { DemoSituation } from "@/types";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const demoStore = useDemoStore();
const jobsStore = useJobsStore();
const player = usePlayer();
const route = useRoute();
const router = useRouter();
const panel = ref<HTMLElement | null>(null);

const active = computed(() => demoStore.applied);
const speedHint = computed(
  () => SPEEDS.find((s) => s.value === demoStore.speed)?.hint ?? `${demoStore.speed}×`,
);
/** a row that opens on the page that is open now */
const here = (s: Pick<DemoSituation, "path">) => s.path.split("?")[0] === route.path;

// ---- what a reset reaches, said before it is pressed
const running = computed(() => jobsStore.activeJobs.length);
const resetLine = computed(() =>
  running.value
    ? `Drops ${running.value} ${running.value === 1 ? "run" : "runs"} in flight.`
    : "Nothing is running now.",
);

/** On a phone the drawer is the whole screen, so it stays shut once the page has loaded again. */
const narrow = () => window.matchMedia("(max-width: 639px)").matches;

// Both load the page again, so what was playing is stopped first: its clip is from the old world.
function pick(s: DemoSituation) {
  player.stop();
  void demoStore.applyScenario(s.id, { reopen: !narrow() });
}
function reset() {
  player.stop();
  void demoStore.resetDemo(route.fullPath, { reopen: !narrow() });
}
function openPage() {
  if (active.value) void router.push(active.value.path);
}
// ---- in and out. Both reload the page; a false is a storage that would not keep the choice, and
// the page would come straight back as it is, so say so instead.
const stuck = ref(false);
function enter() {
  stuck.value = !enterDemo();
}
function leave() {
  player.stop();
  stuck.value = !leaveDemo();
}

// focus goes in when it opens, and the demo's situations are read the first time; Esc closes from
// anywhere inside it. The root class lets the toast stack step aside from the drawer (toasts.css)
// rather than land on top of it.
watch(
  () => props.open,
  async (v) => {
    document.documentElement.classList.toggle("demo-drawer-open", v);
    if (!v) return;
    if (isDemo) void demoStore.load();
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
              <DemoIcon class="icon-sm" /> {{ isDemo ? "Demo mode" : "Demo" }}
            </div>
            <p v-if="isDemo" class="mt-0.5 leading-relaxed text-zinc-500">
              A demo library on the server, its endpoints simulated and nothing billed. A row seeds
              it again with that situation, so the same row gives the same situation every time.
            </p>
            <p v-else class="mt-0.5 leading-relaxed text-zinc-500">
              You are on your own library, from the server.
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

        <!-- on the server's library: what the demo is, and the way in -->
        <section v-if="!isDemo" class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div class="text-sm font-medium">Try the app on seeded books</div>
          <p class="mt-1 leading-relaxed text-zinc-600 dark:text-zinc-300">
            The demo is a second library on the server, seeded with books at different points. Its
            endpoints are simulated: scripting, narration and builds run on the server's queue as
            they would on yours, but nothing is sent to a provider and nothing is billed. Your
            library is left exactly as it is.
          </p>
          <p class="mt-2 leading-relaxed text-zinc-500">
            It opens in this tab only, and stays until you leave it or close the tab; a new tab
            opens on your library. Entering reloads the page.
          </p>
          <button class="btn-primary btn-xs mt-3" @click="enter">
            <EnterIcon class="icon-sm" /> Enter demo
          </button>
          <p v-if="stuck" role="alert" class="mt-2 leading-relaxed text-red-600 dark:text-red-400">
            This browser would not keep the choice — its storage for this site is blocked — so the
            demo cannot open here.
          </p>
        </section>

        <div v-else data-scroll class="min-h-0 flex-1 overflow-y-auto">
          <!-- where the world is now -->
          <section
            class="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800"
            :class="active && 'bg-violet-50/60 dark:bg-violet-500/5'"
            aria-live="polite"
          >
            <div class="label mb-1">Now</div>
            <template v-if="active">
              <div class="text-sm font-medium">{{ active.name }}</div>
              <p v-if="active.note" class="mt-1 leading-relaxed text-zinc-600 dark:text-zinc-300">
                {{ active.note }}
              </p>
              <ol v-if="active.steps.length" class="mt-2 space-y-1">
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
                <button class="btn-ghost btn-xs" :disabled="demoStore.busy" @click="reset">
                  <ResetIcon class="icon-sm" /> Reset
                </button>
              </div>
            </template>
            <template v-else>
              <div class="text-sm font-medium">The demo as it is seeded</div>
              <p class="mt-1 leading-relaxed text-zinc-500">
                Nothing applied: four books at different points, a queue with a few runs going, and
                every endpoint simulated. Pick a situation below.
              </p>
            </template>
          </section>

          <!-- every situation -->
          <section class="px-4 py-3">
            <div class="label mb-2">Situations</div>
            <p v-if="!demoStore.loaded" class="text-zinc-500">
              {{
                demoStore.busy
                  ? "Reading the demo's situations…"
                  : "The situations could not be read."
              }}
            </p>
            <div
              v-for="g in demoStore.grouped"
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
                :disabled="demoStore.busy"
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

        <footer
          v-if="isDemo"
          class="shrink-0 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800"
        >
          <div class="label mb-1">Simulation</div>
          <div class="flex flex-wrap items-center gap-2">
            <span id="demo-speed">Simulated jobs run at</span>
            <UiToggleGroup
              :model-value="demoStore.speed"
              :options="SPEEDS.map((s) => ({ value: s.value, label: s.label }))"
              aria-labelledby="demo-speed"
              @update:model-value="(v) => demoStore.setSpeed(Number(v))"
            />
            <span class="text-zinc-500">{{ speedHint }}</span>
          </div>
          <p class="mb-2 mt-0.5 leading-relaxed text-zinc-500">
            Divides every simulated wait in the demo library: a line, a scripting request, a build's
            chapter. A run already going picks it up at its next one, and what a request records is
            the time it took.
          </p>
          <div class="mt-3 flex items-start gap-2">
            <button class="btn-ghost btn-xs shrink-0" :disabled="demoStore.busy" @click="reset">
              <ResetIcon class="icon-sm" /> Reset the demo data
            </button>
            <p class="leading-relaxed text-zinc-500">
              Seeds the demo library again as it began: every book, script, voice, job and export,
              and the runs it starts with. {{ resetLine }} The page loads again.
            </p>
          </div>
          <div class="mt-2 flex items-start gap-2">
            <button class="btn-ghost btn-xs shrink-0" @click="leave">
              <LeaveIcon class="icon-sm" /> Leave demo
            </button>
            <p class="leading-relaxed text-zinc-500">
              Back to your library on the server. The page reloads; what was done here stays in the
              demo library and never reaches yours.
            </p>
          </div>
          <p v-if="stuck" role="alert" class="mt-2 leading-relaxed text-red-600 dark:text-red-400">
            This browser would not forget the choice — its storage for this site is blocked — so the
            page cannot leave the demo.
          </p>
        </footer>
      </aside>
    </Transition>
  </Teleport>
</template>
