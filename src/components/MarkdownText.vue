<script setup lang="ts">
// A chapter's prose, as the EPUB laid it out: headings, emphasis, lists, links and the tables a
// chapter was sometimes built in.
//
// **Nothing here renders HTML.** The text came out of a file somebody uploaded, so `v-html` would
// be a straight path from "import this EPUB" to running script on the page. Every branch below
// interpolates text, which Vue escapes, and the decisions worth testing — which links are
// followable, how a run of stress flattens — are in `@/lib/markdown` rather than in this template.
import { computed } from "vue";
import type { Token, Tokens } from "marked";

import { blocksOf, inlineOf, piecesOf, rowsOf } from "@/lib/markdown";
import MarkdownInline from "@/components/MarkdownInline.vue";

// `text` is a chapter as it is stored; `blocks` is the inside of a block this component has already
// parsed — a quote, or a list item, which holds blocks of its own and is drawn by recursing rather
// than by re-lexing prose that has been lexed once.
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
      <!-- An item holds blocks, not words: a list under a list is a list, and drawing the item as
           one inline run would leave the child list nowhere to go. -->
      <li v-for="(item, j) in (block as Tokens.List).items" :key="j">
        <MarkdownText :blocks="item.tokens" />
      </li>
    </component>

    <!-- A table a chapter was laid out in: shown as the table it is, rather than dropped. -->
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

    <!-- A tight list item's own words: an inline run with no paragraph of its own around it. -->
    <template v-else-if="block.type === 'text'">
      <MarkdownInline :pieces="inlineOf(block)" />
    </template>

    <p v-else-if="block.type !== 'space'" class="my-2 whitespace-pre-line">
      {{ (block as { raw?: string }).raw ?? "" }}
    </p>
  </template>
</template>
