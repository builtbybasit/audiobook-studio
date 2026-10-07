<script setup lang="ts">
// PROTOTYPE — throwaway. A floating pill that flips a page between design variants kept in
// `?variant=`. Hidden outside dev builds so a stray merge cannot ship it.
import { computed, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";

const props = defineProps<{ variants: { key: string; name: string }[]; current: string }>();
const DEV = import.meta.env.DEV;
const route = useRoute();
const router = useRouter();
const i = computed(() =>
  Math.max(
    0,
    props.variants.findIndex((v) => v.key === props.current),
  ),
);
const go = (d: number) => {
  const v = props.variants[(i.value + d + props.variants.length) % props.variants.length];
  void router.replace({ query: { ...route.query, variant: v.key } });
};
function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable) return;
  if (e.key === "ArrowLeft") go(-1);
  else if (e.key === "ArrowRight") go(1);
}
onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div
    v-if="DEV"
    class="fixed right-3 top-1/2 z-50 w-36 -translate-y-1/2 rounded-xl border-2 border-fuchsia-500 bg-zinc-900 px-2 py-1.5 text-center font-mono text-xs text-white shadow-2xl"
    :title="variants[i].name"
  >
    <div class="flex items-center justify-between">
      <button class="rounded px-1.5 hover:bg-white/15" title="previous variant (←)" @click="go(-1)">
        ◀
      </button>
      <span
        ><b>{{ variants[i].key }}</b>&nbsp;
        <span class="text-zinc-400">{{ i + 1 }}/{{ variants.length }}</span></span
      >
      <button class="rounded px-1.5 hover:bg-white/15" title="next variant (→)" @click="go(1)">
        ▶
      </button>
    </div>
    <div class="truncate text-[10px] text-fuchsia-300">{{ variants[i].name }}</div>
  </div>
</template>
