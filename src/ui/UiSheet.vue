<script setup lang="ts">
// A panel that slides over the page from one edge, on reka-ui's Dialog: a job's details from the
// right, a chapter's text from the bottom on a phone. The overlay and the focus handling are
// UiDialog's; the size along the edge (`max-w-2xl`, `h-[88dvh]`) is the caller's `class`.
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot } from "reka-ui";
import { OVERLAY } from "@/ui/dialog";

defineOptions({ inheritAttrs: false });
withDefaults(defineProps<{ side?: "right" | "bottom" }>(), { side: "right" });
const open = defineModel<boolean>("open", { default: false });

const SIDE = {
  right: "inset-y-0 right-0 w-full border-l border-zinc-200 dark:border-zinc-800",
  bottom: "inset-x-0 bottom-0 rounded-t-2xl",
};
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay :class="OVERLAY" />
      <DialogContent
        v-bind="$attrs"
        class="fixed z-50 flex flex-col bg-white shadow-2xl focus:outline-none dark:bg-zinc-950"
        :class="SIDE[side]"
      >
        <slot />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
