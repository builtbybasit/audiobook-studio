<script setup lang="ts">
// The strip above the list: every note the import attached, grouped by kind, with one decision per
// group and one for all of them. It reads the way the person decides — "these 12 are sponsor
// thanks: skip them" — and it goes quiet once everything is decided, so a clean book never sees it.
import { computed } from "vue";
import { plural } from "@/lib/contents";
import type { ContentsSummary, NoticeGroup, NoticeKind } from "@/types";
import { ChevronDown as OpenIcon, ChevronUp as CloseIcon } from "@lucide/vue";

const props = defineProps<{
  groups: NoticeGroup[];
  summary: ContentsSummary;
  /** the group the list is currently narrowed to */
  kind: NoticeKind | null;
  open: boolean;
}>();
const emit = defineEmits<{
  review: [kind: NoticeKind | null];
  skipGroup: [g: NoticeGroup];
  keepGroup: [g: NoticeGroup];
  skipAll: [];
  "update:open": [boolean];
}>();

const pending = computed(() => props.summary.suggested + props.summary.review);
const skipGroups = computed(() => props.groups.filter((g) => g.verdict === "skip"));
const reviewGroups = computed(() => props.groups.filter((g) => g.verdict === "review"));
const decided = computed(() => props.summary.noted - pending.value);
</script>

<template>
  <section
    v-if="summary.noted"
    class="border-b border-zinc-200 bg-white text-xs dark:border-zinc-800 dark:bg-zinc-900"
    aria-label="Suggestions"
  >
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 sm:px-6">
      <button
        class="flex items-center gap-1.5 text-left font-medium"
        :aria-expanded="open"
        aria-controls="contents-suggestions"
        @click="emit('update:open', !open)"
      >
        <component :is="open ? CloseIcon : OpenIcon" class="icon-sm text-zinc-400" />
        <template v-if="pending">
          {{ plural(pending, "chapter") }} to decide
          <span class="font-normal text-zinc-500">
            · {{ summary.suggested }} look like notices<template v-if="summary.review"
              >, {{ summary.review }} need a look</template
            ></span
          >
        </template>
        <template v-else>
          Every note is decided
          <span class="font-normal text-zinc-500">
            · {{ summary.noted }} noted, {{ summary.skipped }} skipped,
            {{ summary.kept }} kept</span
          >
        </template>
      </button>
      <button
        v-if="summary.suggested"
        class="btn-primary btn-xs ml-auto"
        :title="`Skips every chapter suggested for skipping, in every volume, whatever the search or filter shows. Undo is one click.`"
        @click="emit('skipAll')"
      >
        Skip all {{ summary.suggested }} suggested
      </button>
      <span v-else-if="decided" class="ml-auto text-zinc-400"
        >skipped chapters stay in the book</span
      >
    </div>

    <div
      v-show="open"
      id="contents-suggestions"
      class="grid max-h-[32vh] gap-x-6 gap-y-1 overflow-auto border-t border-zinc-100 px-4 py-2 sm:px-6 md:grid-cols-2 dark:border-zinc-800"
    >
      <div
        v-for="g in [...skipGroups, ...reviewGroups]"
        :key="g.kind"
        class="flex min-w-0 items-center gap-2 py-0.5"
      >
        <span
          class="h-1.5 w-1.5 shrink-0 rounded-full"
          :class="g.verdict === 'skip' ? 'bg-amber-500' : 'bg-violet-500'"
        ></span>
        <span class="min-w-0 flex-1 truncate">
          <span class="font-medium">{{ g.label }}</span>
          <span class="text-zinc-500">
            · {{ g.ids.length
            }}<template v-if="g.pending.length !== g.ids.length">
              · {{ g.pending.length }} to decide</template
            ><template v-if="g.skipped"> · {{ g.skipped }} skipped</template
            ><template v-if="g.kept"> · {{ g.kept }} kept</template></span
          >
        </span>
        <button
          class="chip"
          :class="kind === g.kind && 'chip-on'"
          :aria-pressed="kind === g.kind"
          :title="`Show only these ${g.ids.length} chapters`"
          @click="emit('review', kind === g.kind ? null : g.kind)"
        >
          {{ kind === g.kind ? "Showing" : "Review" }}
        </button>
        <button
          v-if="g.verdict === 'skip' && g.pending.length"
          class="chip"
          :title="`Skip these ${g.pending.length}, in every volume. Undo is one click.`"
          @click="emit('skipGroup', g)"
        >
          Skip {{ g.pending.length }}
        </button>
        <button
          v-else-if="g.verdict === 'review' && g.pending.length"
          class="chip"
          :title="`Keep these ${g.pending.length} as they are. The note stays visible here.`"
          @click="emit('keepGroup', g)"
        >
          Keep {{ g.pending.length }}
        </button>
      </div>
      <p v-if="reviewGroups.length" class="text-[11px] leading-relaxed text-zinc-500 md:col-span-2">
        A chapter that needs a look is story with something else around it. Keeping it puts the
        whole chapter in; the note can be trimmed in Scripting once the chapter is scripted.
      </p>
    </div>
  </section>
</template>
