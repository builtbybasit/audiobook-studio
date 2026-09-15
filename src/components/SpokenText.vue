<script setup lang="ts">
import { useCastStore } from "@/stores/cast";

// The book's own text, with every word the pronunciation dictionary rewrites marked underneath.
// Nothing here edits anything: the prose is the author's, the respelling only leaves in the request.
import { computed } from "vue";

import { marks } from "@/lib/speech";
const props = defineProps<{ bookId: string; text: string }>();
const castStore = useCastStore();
const parts = computed(() => marks(props.text, castStore.lexiconOf(props.bookId)));
</script>

<template>
  <span
    ><template v-for="(m, i) in parts" :key="i"
      ><span
        v-if="m.say"
        class="lex"
        :title="`said as “${m.say}” — the dictionary rewrites it on the way to the endpoint`"
        >{{ m.text }}</span
      ><template v-else>{{ m.text }}</template></template
    ></span
  >
</template>
