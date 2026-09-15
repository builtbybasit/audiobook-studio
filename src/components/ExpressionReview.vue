<script setup lang="ts">
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";

import { computed } from "vue";
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "reka-ui";
import { X as CloseIcon } from "@lucide/vue";

import ExpressionEditor from "@/components/ExpressionEditor.vue";
const narrationStore = useNarrationStore();
const scriptsStore = useScriptsStore();
const pending = computed(() => narrationStore.expressionReview);
const rows = computed(
  () =>
    pending.value?.targets.flatMap((t) => {
      const s = scriptsStore
        .segmentsOf(pending.value!.bookId, t.chId)
        .find((s) => s.id === t.segId);
      if (!s) return [];
      const issues = narrationStore.expressionRender(pending.value!.bookId, s).issues;
      return issues.length ? [{ ...t, s, issues }] : [];
    }) ?? [],
);
const count = computed(() => rows.value.reduce((n, r) => n + r.issues.length, 0));
</script>
<template>
  <DialogRoot
    :open="!!pending"
    @update:open="
      (v) => {
        if (!v) narrationStore.expressionReview = null;
      }
    "
    ><DialogPortal
      ><DialogOverlay class="fixed inset-0 z-50 bg-black/40" /><DialogContent
        class="fixed left-1/2 top-1/2 z-50 flex max-h-[90dvh] w-[min(740px,96vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-2xl focus:outline-none dark:bg-zinc-950"
        data-expression-editor
      >
        <header class="border-b border-zinc-200 p-4 dark:border-zinc-800">
          <div class="flex gap-2">
            <DialogTitle class="text-lg font-semibold"
              >Review expressions before narration</DialogTitle
            ><DialogClose class="btn-ghost btn-xs ml-auto" aria-label="Close expression review"
              ><CloseIcon class="icon"
            /></DialogClose>
          </div>
          <DialogDescription class="mt-2 text-sm text-zinc-500"
            >{{
              count
                ? `${count} expression${count === 1 ? "" : "s"} across ${rows.length} line${rows.length === 1 ? "" : "s"} ${count === 1 ? "needs" : "need"} attention. Nothing has been queued.`
                : "All expression issues are resolved. You can continue narration."
            }}
            Replace a tag, choose its position, configure this model, or explicitly omit
            it.</DialogDescription
          >
        </header>
        <div class="min-h-0 space-y-4 overflow-y-auto p-4">
          <section
            v-for="row in rows"
            :key="`${row.chId}:${row.segId}`"
            class="rounded-lg border border-amber-200 p-3 dark:border-amber-600/30"
          >
            <h3 class="mb-3 text-sm font-medium">
              Chapter {{ row.chId }} · line {{ row.segId }} · {{ row.s.speaker }}
            </h3>
            <ExpressionEditor
              :book-id="pending!.bookId"
              :chapter-id="row.chId"
              :segment="row.s"
              start-open
            />
          </section>
          <p v-if="!count" class="py-5 text-sm text-emerald-600">
            Ready to narrate. Omitted annotations remain in the script and can be enabled again.
          </p>
        </div>
        <footer class="border-t border-zinc-200 p-4 dark:border-zinc-800">
          <div class="flex flex-wrap gap-2">
            <button
              v-if="count"
              class="btn-ghost btn-xs"
              @click="narrationStore.omitReviewExpressions()"
            >
              Omit {{ count }} expression{{ count === 1 ? "" : "s" }} needing review</button
            ><button
              class="btn-primary btn-xs ml-auto"
              :disabled="!!count"
              @click="narrationStore.continueExpressionReview()"
            >
              Continue narration
            </button>
          </div>
          <p v-if="count" class="mt-2 text-xs text-zinc-500">
            Omitting is saved on these annotations until you enable them again. It does not delete
            them or change the prose.
          </p>
        </footer>
      </DialogContent></DialogPortal
    ></DialogRoot
  >
</template>
