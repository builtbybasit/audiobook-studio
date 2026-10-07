<script setup lang="ts">
// "?" anywhere outside a field, or the palette entry, opens the shortcut reference.
import { DialogDescription, DialogTitle } from "reka-ui";
import { modKey as mod } from "@/lib/format";
import { UiDialog } from "@/ui";
const open = defineModel("open", { type: Boolean });
const groups = [
  {
    title: "Anywhere",
    keys: [
      [`${mod} K`, "command palette"],
      [`${mod} Z`, "undo the last merge / rename / removal"],
      ["?", "this list"],
      ["Esc", "close popups and editors"],
    ],
  },
  {
    title: "Player",
    keys: [
      ["space", "play / pause (not while a button has focus)"],
      ["click the bar", "scrub the stitched chapter"],
      ["⏴⏵", "back / forward 10 seconds"],
      ["⏮ ⏭", "previous / next line"],
      ["1×", "playback speed, up to 2×"],
    ],
  },
  {
    title: "Listen",
    keys: [
      ["click a line / word", "listen from there"],
      ["j / k", "next / previous line"],
      [", / .", "back / forward 10 seconds"],
      ["f", "flag the line playing"],
      ["r", "repeat the line playing"],
      ["[ / ]", "previous / next flagged line"],
    ],
  },
  {
    title: "Script reader",
    keys: [
      ["j / k · ↑ ↓", "move between lines"],
      ["↵", "edit the focused line"],
      ["1 – 9", "assign speaker (chapter order)"],
      ["e", "correct the words of the focused line"],
      ["p", "play the chapter from the focused line"],
      ["s", "split the focused line at a word gap"],
      ["m", "join the focused line with the next one"],
      ["c", "toggle the cast rail"],
      ["f", "toggle reader focus mode"],
      ["/", "focus the chapter search"],
    ],
  },
  {
    title: "Chapter picker",
    keys: [
      ["↑ ↓", "move between chapters"],
      ["space", "tick / untick"],
      ["↵", "open the chapter"],
      ["shift-click", "select a range"],
      ["/", "search the chapter list"],
    ],
  },
  {
    title: "Contents review",
    keys: [
      ["↑ ↓ · j k", "move between chapters"],
      ["space", "include / skip for the audiobook"],
      ["↵", "read the chapter in full"],
      ["n", "next chapter still to decide"],
      ["shift-click", "include / skip a range"],
      ["/", "search the chapters"],
    ],
  },
  {
    title: "Contents · Volumes",
    keys: [
      ["↑ ↓", "move between volumes"],
      ["↵ · space", "open the volume's chapters"],
      ["F2", "rename the volume"],
      ["⌦", "join with the volume before"],
      ["← → on a handle", "move the boundary (shift: ten chapters)"],
      ["double-click the bar", "cut a volume there"],
    ],
  },
  {
    title: "Narration ledger",
    keys: [
      ["j / k", "move between segments"],
      ["↵ / p", "play the segment"],
      ["r", "retry a failed segment"],
      ["f", "flag the clip (pronunciation / delivery / pause)"],
      ["t", "retake — render it again and compare"],
      ["1 / 2", "play the current take / retake"],
      ["a / x", "keep the new take / keep the previous one"],
      ["click · i", "show render details"],
      ["e", "edit the line in the reader"],
    ],
  },
  {
    title: "Cast table",
    keys: [
      ["j / k", "move between speakers"],
      ["v", "open the voice picker"],
      ["↵", "rename"],
      ["x", "tick for bulk merge"],
    ],
  },
];
</script>
<template>
  <UiDialog
    v-model:open="open"
    class="card max-h-[85vh] w-[min(560px,92vw)] overflow-auto p-5 text-sm"
  >
    <DialogTitle class="mb-1 text-lg font-semibold">Keyboard shortcuts</DialogTitle>
    <DialogDescription class="mb-4 text-xs text-zinc-500"
      >Shortcuts are ignored while you type in a field. Apart from the first group, each set belongs
      to its own pane and acts on the pane you last clicked in.</DialogDescription
    >
    <div class="grid gap-4 sm:grid-cols-2">
      <div v-for="g in groups" :key="g.title">
        <div class="label mb-1.5">{{ g.title }}</div>
        <div v-for="[k, d] in g.keys" :key="k" class="flex items-baseline gap-2 py-0.5">
          <kbd
            class="shrink-0 rounded border border-zinc-200 bg-zinc-50 px-1.5 font-mono text-[11px] dark:border-zinc-700 dark:bg-zinc-800"
            >{{ k }}</kbd
          ><span class="text-xs text-zinc-600 dark:text-zinc-400">{{ d }}</span>
        </div>
      </div>
    </div>
  </UiDialog>
</template>
