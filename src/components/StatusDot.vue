<script setup lang="ts">
import { dotClass } from "@/components/statusDot";
defineProps<{ status?: string }>();
</script>
<template>
  <span :class="dotClass(status)" :data-tip="status"></span>
</template>
