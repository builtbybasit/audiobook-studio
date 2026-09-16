<script setup lang="ts">
// The Demo tools: every seeded situation worth testing, in one small panel.
//
// Prototype only, and deliberately out of the way — a chip in the header rather than a control on
// any page, so the workflow screens stay the workflow. Picking a row puts the whole demo world into
// that situation (book, script, cast, jobs and exports together), abandons whatever was running and
// opens the page the situation is about. Reset puts everything back to the seeded world.
import { useDemoStore } from "@/stores/demo";

import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { FlaskConical as DemoIcon, RotateCcw as ResetIcon } from "@lucide/vue";

import { DEMO_GROUPS } from "@/mock";
import { usePlayer } from "@/composables/usePlayer";
import { UiSwitch } from "@/ui";

const demoStore = useDemoStore();
const player = usePlayer();
const route = useRoute();
const router = useRouter();

const groups = computed(() =>
  DEMO_GROUPS.map((g) => ({
    ...g,
    rows: demoStore.scenarios.filter((s) => s.group === g.id),
  })).filter((g) => g.rows.length),
);
const active = computed(() => demoStore.activeScenario);

/**
 * A book imported during the session is not in the seeded world, so restoring it takes the book out
 * from under whatever page is open on it. Leave first and wait for the route to change: a stage view
 * reads its book straight out of the store, and would render once against a book that had gone.
 */
async function leaveIfBookGoes() {
  const bookId = String(route.params.bookId ?? "");
  if (bookId && !demoStore.survivesReset(bookId)) await router.push("/library");
}
async function pick(id: string) {
  player.stop(); // it is timing clips from a world that is about to be replaced
  await leaveIfBookGoes();
  const to = demoStore.applyScenario(id);
  if (to) router.push(to);
}
async function reset() {
  player.stop();
  await leaveIfBookGoes();
  demoStore.resetDemo();
}
</script>

<template>
  <PopoverRoot>
    <PopoverTrigger
      class="chip"
      :class="active && 'chip-on'"
      :title="
        active
          ? `Demo mode · ${active.name} is applied`
          : 'Demo mode · seeded scenarios and simulated costs'
      "
      aria-label="Demo tools"
    >
      <DemoIcon class="icon-sm" /> Demo
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        align="end"
        :side-offset="6"
        class="ui-popup flex max-h-[min(34rem,80vh)] w-[min(28rem,92vw)] flex-col text-xs"
      >
        <div class="border-b border-zinc-200 p-3 dark:border-zinc-800">
          <div class="label mb-1">Demo mode</div>
          <p class="leading-relaxed text-zinc-500">
            This prototype runs entirely on seeded data and simulated jobs. No provider is called
            and no AI request is made — every cost, duration and file size on screen is invented.
          </p>
        </div>

        <div class="min-h-0 flex-1 overflow-auto p-3">
          <div v-for="g in groups" :key="g.id" role="group" :aria-labelledby="`demo-${g.id}`">
            <div :id="`demo-${g.id}`" class="label mb-1 mt-2">{{ g.label }}</div>
            <button
              v-for="s in g.rows"
              :key="s.id"
              class="mb-1 w-full rounded-md border p-2 text-left hover:border-violet-400 dark:hover:border-violet-500"
              :class="
                active?.id === s.id
                  ? 'border-violet-400 bg-violet-500/10 dark:border-violet-500'
                  : 'border-zinc-200 dark:border-zinc-700'
              "
              :aria-current="active?.id === s.id ? 'true' : undefined"
              @click="pick(s.id)"
            >
              <div class="font-medium">{{ s.name }}</div>
              <div class="mt-0.5 leading-relaxed text-zinc-500">{{ s.blurb }}</div>
            </button>
          </div>
        </div>

        <div class="border-t border-zinc-200 p-3 dark:border-zinc-800">
          <UiSwitch v-model="demoStore._exportFails" label="make the next build fail" />
          <p class="mt-1 leading-relaxed text-zinc-500">
            One shot. The build stops part-way, the previous version stays on disk, and the failure
            offers a retry.
          </p>
          <div v-if="active" class="mt-2 leading-relaxed text-zinc-500">
            Applied:
            <span class="font-medium text-zinc-700 dark:text-zinc-200">{{ active.name }}</span>
          </div>
          <button class="btn-ghost btn-xs mt-2 w-full justify-center" @click="reset">
            <ResetIcon class="icon-sm" /> Reset the demo data
          </button>
          <p class="mt-1 leading-relaxed text-zinc-500">
            Puts every book, script, voice, job and export back to its seeded state and stops
            whatever is running.
          </p>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
