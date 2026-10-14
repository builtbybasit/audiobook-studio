<script setup lang="ts">
// A chapter's prose as the EPUB laid it out. **Nothing here renders HTML**: the text comes from an
// uploaded file, so `v-html` would run its scripts. Link and stress rules live in `@/lib/markdown`.
import { computed } from "vue";
import type { Token, Tokens } from "marked";

import { blocksOf, inlineOf, piecesOf, rowsOf } from "@/lib/markdown";
import MarkdownInline from "@/components/MarkdownInline.vue";

// `blocks`: the inside of an already-parsed quote or list item, drawn by recursing, not re-lexing.
const props = defineProps<{ text?: string; blocks?: readonly Token[] }>();

const blocks = computed(() => props.blocks ?? blocksOf(props.text ?? ""));
</script>

<template>
  <template v-for="(block, i) in blocks" :key="i">
    <component
      :is="`h${Math.min(6, (block as Tokens.Heading).depth ?? 2)}`"
      v-if="block.type === 'heading'"
      class="mt-3 mb-1 font-serif font-semibold first:mt-0"
    >
      <MarkdownInline :pieces="inlineOf(block)" />
    </component>

    <p v-else-if="block.type === 'paragraph'" class="my-2 whitespace-pre-line first:mt-0">
      <MarkdownInline :pieces="inlineOf(block)" />
    </p>

    <blockquote
      v-else-if="block.type === 'blockquote'"
      class="my-2 border-l-2 border-zinc-300 pl-3 italic dark:border-zinc-700"
    >
      <MarkdownText :blocks="(block as Tokens.Blockquote).tokens" />
    </blockquote>

    <component
      :is="(block as Tokens.List).ordered ? 'ol' : 'ul'"
      v-else-if="block.type === 'list'"
      class="my-2 space-y-0.5 pl-5"
      :class="(block as Tokens.List).ordered ? 'list-decimal' : 'list-disc'"
    >
      <!-- an item holds blocks, so a nested list has somewhere to go -->
      <li v-for="(item, j) in (block as Tokens.List).items" :key="j">
        <MarkdownText :blocks="item.tokens" />
      </li>
    </component>

    <div v-else-if="block.type === 'table'" class="my-2 overflow-x-auto">
      <table class="w-full border-collapse text-[13px]">
        <tbody>
          <tr
            v-for="(row, r) in rowsOf(block as Tokens.Table)"
            :key="r"
            class="border-b border-zinc-200 last:border-0 dark:border-zinc-800"
          >
            <component
              :is="row.head ? 'th' : 'td'"
              v-for="(cell, c) in row.cells"
              :key="c"
              class="px-2 py-1 text-left align-top"
              :class="row.head && 'font-medium'"
            >
              <MarkdownInline :pieces="piecesOf(cell.tokens, cell.text)" />
            </component>
          </tr>
        </tbody>
      </table>
    </div>

    <pre
      v-else-if="block.type === 'code'"
      class="my-2 overflow-x-auto rounded bg-zinc-100 p-2 text-[12px] dark:bg-zinc-900"
      >{{ (block as Tokens.Code).text }}</pre>

    <hr v-else-if="block.type === 'hr'" class="my-3 border-zinc-200 dark:border-zinc-800" />

    <template v-else-if="block.type === 'text'">
      <MarkdownInline :pieces="inlineOf(block)" />
    </template>

    <p v-else-if="block.type !== 'space'" class="my-2 whitespace-pre-line">
      {{ (block as { raw?: string }).raw ?? "" }}
    </p>
  </template>
</template>
