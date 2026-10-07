<script setup lang="ts">
// The "To decide" tab: an inbox of only the chapters the import flagged, grouped by kind — each
// card the reason, the evidence and Skip / Keep — with one decision per group and one for every
// suggested skip. It reads the way the person decides ("these 12 are sponsor thanks: skip them")
// and a clean book finds it empty.
import { computed } from "vue";
import { excerptOf, stateOf } from "@/lib/contents";
import { STATE_CHIP } from "@/views/contents/shared";
import type { ContentsPage } from "@/views/contents/useContents";
import type { Chapter } from "@/types";

const props = defineProps<{ page: ContentsPage }>();
const p = props.page;
const byKind = computed(() =>
  p.groups.value.map((g) => ({
    ...g,
    chapters: g.ids.map((id) => p.chapters.value.find((c) => c.id === id)!),
  })),
);
const line = (c: Chapter) => excerptOf(p.textOf(c), 120);
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto">
    <div
      v-if="!p.summary.value.noted"
      class="grid h-full place-items-center p-8 text-center text-sm text-zinc-500"
    >
      Nothing to decide: every chapter reads as story and goes in.
    </div>
    <template v-else>
      <div
        v-if="p.summary.value.suggested"
        class="flex items-center gap-2 border-b border-amber-200 bg-amber-400/10 px-4 py-2 text-xs dark:border-amber-500/30"
      >
        <span>{{ p.summary.value.suggested }} chapters look like notices, not story.</span>
        <button class="btn-primary btn-xs ml-auto" @click="p.skipAllSuggested()">
          Skip them all
        </button>
      </div>
      <section
        v-for="g in byKind"
        :key="g.kind"
        class="border-b border-zinc-200 dark:border-zinc-800"
      >
        <header
          class="sticky top-0 z-10 flex items-center gap-2 bg-zinc-50 px-4 py-1.5 text-xs dark:bg-zinc-900"
        >
          <span
            class="h-1.5 w-1.5 rounded-full"
            :class="g.verdict === 'skip' ? 'bg-amber-500' : 'bg-violet-500'"
          ></span>
          <span class="font-semibold">{{ g.label }}</span>
          <span class="text-zinc-500"
            >{{ g.ids.length
            }}<template v-if="g.pending.length !== g.ids.length">
              · {{ g.pending.length }} to decide</template
            ></span
          >
          <button
            v-if="g.verdict === 'skip' && g.pending.length"
            class="chip ml-auto"
            @click="p.skipGroup(g)"
          >
            Skip all {{ g.pending.length }}
          </button>
          <button v-else-if="g.pending.length" class="chip ml-auto" @click="p.keepGroup(g)">
            Keep all {{ g.pending.length }}
          </button>
        </header>
        <div
          v-for="c in g.chapters"
          :key="c.id"
          class="flex items-start gap-3 border-t border-zinc-100 px-4 py-2 text-sm dark:border-zinc-800/60"
          :class="[
            p.opened.value === c.id && 'bg-violet-50 dark:bg-violet-500/10',
            (c.excluded || c.kept) && 'opacity-60',
          ]"
        >
          <span class="mt-0.5 w-10 shrink-0 font-mono text-[11px] text-zinc-400">{{
            p.numbers.value?.get(c.id) ?? "—"
          }}</span>
          <div class="min-w-0 flex-1">
            <button
              class="block max-w-full truncate text-left hover:underline"
              :class="c.excluded && 'line-through'"
              :title="c.title"
              @click="p.open(c.id)"
            >
              {{ c.title }}
            </button>
            <div class="text-[11px] text-zinc-500">
              {{ c.note!.reason }}
              <template v-if="c.note!.evidence.length">
                · {{ c.note!.evidence.join(" · ") }}</template
              >
            </div>
            <div class="truncate font-serif text-[12px] text-zinc-400">{{ line(c) }}</div>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <span
              v-if="c.excluded || c.kept"
              class="chip px-1.5 py-0 text-[10px]"
              :class="STATE_CHIP[stateOf(c)]?.cls"
              >{{ STATE_CHIP[stateOf(c)]?.label }}</span
            >
            <button v-if="c.excluded" class="chip" @click="p.includeOne(c.id)">Include</button>
            <template v-else>
              <button
                class="chip"
                :class="!c.kept && c.note!.verdict === 'skip' && 'chip-on'"
                @click="p.skipOne(c.id)"
              >
                Skip
              </button>
              <button
                v-if="!c.kept"
                class="chip"
                :class="c.note!.verdict === 'review' && 'chip-on'"
                @click="p.keepOne(c.id)"
              >
                Keep
              </button>
            </template>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
