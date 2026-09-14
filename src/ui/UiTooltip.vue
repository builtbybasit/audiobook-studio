<script setup lang="ts">
import { TooltipContent, TooltipPortal, TooltipRoot, TooltipTrigger } from "reka-ui";
defineProps<{ text?: string; side?: "top" | "right" | "bottom" | "left" }>();
</script>
<template>
  <TooltipRoot>
    <TooltipTrigger as-child><slot /></TooltipTrigger>
    <TooltipPortal>
      <TooltipContent
        :side="side"
        :side-offset="4"
        class="z-50 max-w-xs rounded-md bg-zinc-900 px-2 py-1 text-[11px] leading-snug text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900"
        >{{ text }}<slot name="content"
      /></TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
</template>
