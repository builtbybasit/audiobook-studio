<script setup lang="ts">
// A "?" beside a label that opens one short explanation on click (reka Popover), so the page keeps
// to a label and one line. `text` or the default slot is the explanation; `label` names the button.
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { CircleHelp as HelpIcon } from "@lucide/vue";

withDefaults(
  defineProps<{ text?: string; label?: string; side?: "top" | "right" | "bottom" | "left" }>(),
  { text: "", label: "this", side: "top" },
);
</script>

<template>
  <PopoverRoot>
    <PopoverTrigger
      class="inline-flex align-middle text-zinc-400 transition-colors hover:text-violet-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 data-[state=open]:text-violet-500"
      :aria-label="`About ${label}`"
      type="button"
      @click.stop
    >
      <HelpIcon class="icon-sm" />
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        :side="side"
        :side-offset="4"
        class="ui-popup max-w-xs px-3 py-2 text-xs leading-relaxed text-zinc-700 dark:text-zinc-200"
        >{{ text }}<slot
      /></PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
