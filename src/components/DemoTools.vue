<script setup lang="ts">
// The Demo chip in the header, and the drawer it opens (components/DemoDrawer.vue).
//
// Prototype only, and deliberately out of the way — a chip in the header rather than a control on
// any page, so the workflow screens stay the workflow. The chip carries the name of the situation
// the world is in, so it can be read with the drawer closed. The drawer's open state lives here,
// in the one component the shell mounts once, so it survives every route change.
import { useDemoStore } from "@/stores/demo";

import { computed, ref } from "vue";
import DemoDrawer from "@/components/DemoDrawer.vue";
import { FlaskConical as DemoIcon } from "@lucide/vue";

const demoStore = useDemoStore();
const open = ref(false);
const chip = ref<HTMLButtonElement | null>(null);
const active = computed(() => demoStore.activeScenario);
function close() {
  open.value = false;
  chip.value?.focus();
}
</script>

<template>
  <button
    ref="chip"
    class="chip max-w-[16rem]"
    :class="(open || active) && 'chip-on'"
    :aria-expanded="open"
    aria-controls="demo-drawer"
    :title="
      active
        ? `Demo mode · ${active.name} is applied`
        : 'Demo mode · seeded scenarios and simulated costs'
    "
    aria-label="Demo tools"
    @click="open = !open"
  >
    <DemoIcon class="icon-sm" /> Demo<span v-if="active" class="hidden min-w-0 truncate md:inline"
      >&nbsp;· {{ active.name }}</span
    >
  </button>
  <DemoDrawer :open="open" @close="close" />
</template>
