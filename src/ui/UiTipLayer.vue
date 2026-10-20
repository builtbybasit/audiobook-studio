<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { TooltipContent, TooltipPortal, TooltipRoot } from "reka-ui";
// One tooltip for every `data-tip="…"` element (optional `data-tip-side`), so a 900-row list
// costs no component per row. Mounted once, inside the TooltipProvider.
type Side = "top" | "right" | "bottom" | "left";
const DELAY = 300;

const el = shallowRef<HTMLElement | null>(null);
const text = ref("");
const side = ref<Side>("top");
const open = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

const tipOf = (t: EventTarget | null) =>
  t instanceof Element ? t.closest<HTMLElement>("[data-tip]") : null;

// what a native title gave a screen reader: the hovered or focused element is described by the tip
const DESCRIBED = "ui-tip-text";
function show(target: HTMLElement, wait: number) {
  hide();
  if (!target.dataset.tip) return;
  el.value = target;
  text.value = target.dataset.tip;
  side.value = (target.dataset.tipSide as Side) || "top";
  if (!target.hasAttribute("aria-describedby")) target.setAttribute("aria-describedby", DESCRIBED);
  timer = setTimeout(() => (open.value = target.isConnected), wait);
}
function hide() {
  clearTimeout(timer);
  if (el.value?.getAttribute("aria-describedby") === DESCRIBED)
    el.value.removeAttribute("aria-describedby");
  el.value = null;
  open.value = false;
}

function onOver(e: PointerEvent) {
  const t = tipOf(e.target);
  if (t && t !== el.value) show(t, DELAY);
  else if (!t && el.value) hide();
}
function onFocus(e: FocusEvent) {
  const t = tipOf(e.target);
  if (t && t.matches(":focus-visible")) show(t, 0);
}
function onOut(e: FocusEvent) {
  if (el.value && !el.value.contains(e.relatedTarget as Node | null)) hide();
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") hide();
}

const on: [string, EventListener][] = [
  ["pointerover", onOver as EventListener],
  ["pointerdown", hide],
  ["focusin", onFocus as EventListener],
  ["focusout", onOut as EventListener],
  ["keydown", onKey as EventListener],
  ["scroll", hide],
];
onMounted(() => on.forEach(([n, f]) => document.addEventListener(n, f, true)));
onBeforeUnmount(() => {
  clearTimeout(timer);
  on.forEach(([n, f]) => document.removeEventListener(n, f, true));
});
</script>
<template>
  <span :id="DESCRIBED" hidden>{{ text }}</span>
  <TooltipRoot :open="open" disable-hoverable-content>
    <TooltipPortal>
      <TooltipContent
        v-if="el"
        :reference="el"
        :side="side"
        :side-offset="4"
        :aria-label="text"
        class="pointer-events-none z-50 max-w-xs rounded-md bg-zinc-900 px-2 py-1 text-[11px] leading-snug text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900"
        >{{ text }}</TooltipContent
      >
    </TooltipPortal>
  </TooltipRoot>
</template>
