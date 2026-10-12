<script setup lang="ts">
// STUB — replaced by the sheet: try-on list, then the split editor (docs/design-history.md, A8).
import type { EffectSubject } from "./subject";

defineProps<{ bookId: string; subject: EffectSubject | null }>();
const open = defineModel<boolean>("open", { default: false });
</script>

<template>
  <div v-if="open" hidden></div>
</template>
