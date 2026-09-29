<script setup lang="ts">
// The Demo chip in the header, and the drawer it opens (components/DemoDrawer.vue).
//
// Deliberately out of the way — a chip in the header rather than a control on any page, so the
// workflow screens stay the workflow. It is also the way in and out of the demo, so it is there in
// both modes and says which one the tab is in: lit and named "Demo mode" in the demo, with the
// situation the world is in so it can be read with the drawer closed; plain on the server's
// library. The drawer's open state lives here, in the one component the shell mounts once, so it
// survives every route change.
import { useDemoStore } from "@/stores/demo";

import { computed, ref } from "vue";
import DemoDrawer from "@/components/DemoDrawer.vue";
import { isDemo } from "@/services/mode";
import { FlaskConical as DemoIcon } from "@lucide/vue";

const demoStore = useDemoStore();
const open = ref(false);
const chip = ref<HTMLButtonElement | null>(null);
const active = computed(() => (isDemo ? demoStore.activeScenario : null));
const title = computed(() => {
  if (!isDemo) return "Your library, from the server · the demo opens from here";
  return active.value
    ? `Demo mode · ${active.value.name} is applied`
    : "Demo mode · seeded scenarios and simulated costs, in this tab only";
});
function close() {
  open.value = false;
  chip.value?.focus();
}
</script>

<template>
  <button
    ref="chip"
    class="chip h-7 max-w-[16rem] px-2.5 text-xs"
    :class="(open || isDemo) && 'chip-on'"
    :aria-expanded="open"
    aria-controls="demo-drawer"
    :title="title"
    :aria-label="isDemo ? 'Demo tools · in demo mode' : 'Demo · on your own library'"
    @click="open = !open"
  >
    <DemoIcon class="icon-sm" /><span class="hidden sm:inline">{{
      isDemo ? "Demo mode" : "Demo"
    }}</span
    ><span v-if="active" class="hidden min-w-0 truncate md:inline">&nbsp;· {{ active.name }}</span>
  </button>
  <DemoDrawer :open="open" @close="close" />
</template>
