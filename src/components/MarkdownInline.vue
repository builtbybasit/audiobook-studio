<script setup lang="ts">
// The inline run of one block: words, two grades of stress, and links. Every branch interpolates
// text, which Vue escapes. Recurses for a link, so an italic link stays italic.
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
    <!-- a link we will not follow: its words, with nothing to click -->
    <MarkdownInline v-else-if="piece.kind === 'link'" :pieces="piece.pieces" />
    <em v-else-if="piece.kind === 'em'">{{ piece.text }}</em>
    <strong v-else-if="piece.kind === 'strong'">{{ piece.text }}</strong>
    <strong v-else-if="piece.kind === 'both'"
      ><em>{{ piece.text }}</em></strong
    >
    <template v-else>{{ piece.text }}</template>
  </template>
</template>
