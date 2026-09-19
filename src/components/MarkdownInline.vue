<script setup lang="ts">
// The inline run of one block: words, the two grades of stress, and links.
//
// Its own component so the block renderer can stay a list of cases. Every branch interpolates text,
// which Vue escapes — none of it builds markup out of the book's own characters. It recurses into
// itself for a link, whose words are a run of their own: an italic link is still italic.
import type { Piece } from "@/lib/markdown";

defineProps<{ pieces: Piece[] }>();
</script>

<template>
  <template v-for="(piece, i) in pieces" :key="i">
    <a
      v-if="piece.kind === 'link' && piece.href"
      :href="piece.href"
      target="_blank"
      rel="noopener noreferrer nofollow"
      class="underline decoration-dotted underline-offset-2"
      ><MarkdownInline :pieces="piece.pieces"
    /></a>
    <!-- a link the book pointed somewhere we will not follow: its words, with nothing to click -->
    <MarkdownInline v-else-if="piece.kind === 'link'" :pieces="piece.pieces" />
    <em v-else-if="piece.kind === 'em'">{{ piece.text }}</em>
    <strong v-else-if="piece.kind === 'strong'">{{ piece.text }}</strong>
    <strong v-else-if="piece.kind === 'both'"
      ><em>{{ piece.text }}</em></strong
    >
    <template v-else>{{ piece.text }}</template>
  </template>
</template>
