<script setup lang="ts">
// A modal on reka-ui's Dialog: the shared overlay, portal and focus trap. Width, padding and the
// content's events are the caller's, via `class` and listeners on the content.
// `placement`: `center`, `top` (for lists that grow downwards), or `fill` with a margin.
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot } from "reka-ui";
import { OVERLAY } from "@/ui/dialog";

defineOptions({ inheritAttrs: false });
withDefaults(defineProps<{ placement?: "center" | "top" | "fill" }>(), { placement: "center" });
const open = defineModel<boolean>("open", { default: false });

const PLACEMENT = {
  center: "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
  top: "left-1/2 top-[12vh] -translate-x-1/2",
  fill: "inset-x-2 inset-y-2 mx-auto sm:inset-y-8",
};
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay :class="OVERLAY" />
      <DialogContent
        v-bind="$attrs"
        class="fixed z-50 shadow-2xl focus:outline-none"
        :class="PLACEMENT[placement]"
      >
        <slot />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
