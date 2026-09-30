<script setup lang="ts">
// A modal on reka-ui's Dialog: the overlay, the portal and the focus trap every dialog shares, so
// they all dim the page the same way and sit at the same height. What is inside — its width, its
// padding, a card or a bare panel — is the caller's, passed as `class` onto the content, and so are
// the content's own events (`@open-auto-focus.prevent` to keep focus off the first field,
// `@interact-outside` to stop a stray click closing a form).
//
// `placement` is where the panel sits: `center` in the middle, `top` a little way down (the command
// palette, whose list grows downwards), `fill` nearly the whole screen with a margin.
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
