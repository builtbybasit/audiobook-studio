<script setup lang="ts">
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { plural } from "@/lib/contents";

// The book's review inbox: every decision waiting on a person, wherever it lives, with the link
// that lands on it. The counts on the stage pages are unchanged — this is the one place that can
// say how many there are altogether, and the only page that shows them side by side.
//
// It decides nothing itself. Every row leaves for the page that owns the decision, which is also
// the page that owns the undo for it — except a site-text suggestion, a yes or no about one line,
// which can be accepted or dismissed here through the scripts store's own actions and their Undo.
import { computed, ref } from "vue";
import { relative } from "@/lib/endpoints";
import { bookFacts } from "@/views/library/bookFacts";
import { useReviewInbox, type DecisionKind, type DecisionTone } from "@/views/review/inbox";
import EmptyState from "@/components/EmptyState.vue";
import ReadFailure, { scriptsUnread } from "@/components/ReadFailure.vue";
import { useBookId } from "@/composables/useBookId";
import { useBookScripts, useCast } from "@/queries";
import {
  ArrowRight as NextIcon,
  CircleCheck as DoneIcon,
  Flag as FlaggedIcon,
  GitMerge as MergeIcon,
  ListChecks as ContentsIcon,
  Repeat as RetakeIcon,
  ScanSearch as SiteTextIcon,
  Scissors as UnverifiedIcon,
  Sparkles as ExpressionIcon,
  TriangleAlert as FailedIcon,
  UserPlus as SpeakerIcon,
} from "@lucide/vue";
import type { Component } from "vue";
import type { Decision } from "@/views/review/inbox";

const libraryStore = useLibraryStore();
const scriptsStore = useScriptsStore();
const bookId = useBookId();
useCast(bookId);
// retakes, flags and unverified chunks are on the lines: until every scripted chapter's are in,
// "nothing waiting" is not an answer
const { failed: unread, loading: reading, retry: readAgain } = useBookScripts(bookId);
// the router only reaches this view with a real book id
const book = computed(() => libraryStore.bookById(bookId)!);
const groups = useReviewInbox(bookId);
const total = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0));

/** One kind at a time, when the list is long enough that scanning it stops working. */
const only = ref<DecisionKind | null>(null);
const shown = computed(() => groups.value.filter((g) => !only.value || g.kind === only.value));
// a group opens to its first few rows: a book with sixty flagged clips should still be readable
const FIRST = 6;
const expanded = ref(new Set<DecisionKind>());
function expand(kind: DecisionKind) {
  expanded.value = new Set(expanded.value).add(kind);
}

const ICON: Record<DecisionKind, Component> = {
  failed: FailedIcon,
  contents: ContentsIcon,
  unverified: UnverifiedIcon,
  sitetext: SiteTextIcon,
  speaker: SpeakerIcon,
  merge: MergeIcon,
  expression: ExpressionIcon,
  flagged: FlaggedIcon,
  retake: RetakeIcon,
};
/**
 * The stripe down the left edge of a row, and the tint behind the group's icon.
 *
 * The stripe is its own element rather than a `border-l-*` on the row: the row already carries a
 * `dark:border-*` for its divider, and in dark mode that variant sorts after the un-varianted
 * left-colour and painted the stripe out.
 */
const BAR: Record<DecisionTone, string> = {
  red: "bg-red-400",
  amber: "bg-amber-400",
  violet: "bg-violet-400",
  sky: "bg-sky-400",
  zinc: "bg-zinc-300 dark:bg-zinc-600",
};
const TINT: Record<DecisionTone, string> = {
  red: "bg-red-500/10 text-red-600 dark:text-red-400",
  amber: "bg-amber-400/15 text-amber-600 dark:text-amber-400",
  violet: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  sky: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  zinc: "bg-zinc-500/10 text-zinc-500",
};

// when there is nothing to decide, the page still answers "so what now?" — with the same chain the
// shelf card and the overview banner read, not a second opinion
const next = computed(() => bookFacts(bookId).next);

/** A group of lines is read chapter by chapter: a row opens a new chapter when it is in another. */
const opensChapter = (items: Decision[], i: number): boolean =>
  items[i].chapterId != null && items[i].chapterId !== items[i - 1]?.chapterId;
const now = Date.now();
</script>

<template>
  <div v-if="book" class="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
    <div>
      <h1 class="text-2xl font-semibold">Review</h1>
      <p class="mt-1 text-sm text-zinc-500">
        <template v-if="total"
          >{{ plural(total, "decision") }} waiting on you across
          <b class="font-medium text-zinc-700 dark:text-zinc-200">{{ book.title }}</b
          >. Every row opens where it is settled — nothing here is decided for you.</template
        >
        <template v-else-if="reading">Reading the book’s scripts…</template>
        <template v-else-if="!unread.length"
          >Everything this book was waiting on has been decided.</template
        >
      </p>
    </div>

    <div v-if="total" class="flex flex-wrap gap-1.5">
      <button class="chip" :class="!only && 'chip-on'" @click="only = null">
        All <span class="text-zinc-400">{{ total }}</span>
      </button>
      <button
        v-for="g in groups"
        :key="g.kind"
        class="chip"
        :class="only === g.kind && 'chip-on'"
        @click="only = only === g.kind ? null : g.kind"
      >
        <component :is="ICON[g.kind]" class="icon-sm" />{{ g.label
        }}<span class="text-zinc-400">{{ g.items.length }}</span>
      </button>
    </div>

    <ReadFailure
      v-if="unread.length"
      :message="`${scriptsUnread(unread.length)}, so what waits in ${unread.length === 1 ? 'it' : 'them'} is not listed.`"
      @retry="readAgain"
    />

    <div v-if="!total && !reading && !unread.length">
      <EmptyState
        :icon="DoneIcon"
        title="Nothing waiting"
        body="No retakes to compare, no flagged clips, no speakers to review, no chunks to re-split and no failed runs. The stages themselves may still have work to run."
      >
        <RouterLink :to="`/book/${bookId}/${next.to}`" class="btn-primary">{{
          next.label
        }}</RouterLink>
      </EmptyState>
    </div>

    <section v-for="g in shown" :key="g.kind" class="card overflow-hidden">
      <div
        class="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800"
      >
        <span
          class="grid h-6 w-6 shrink-0 place-items-center self-center rounded-md"
          :class="TINT[g.tone]"
          ><component :is="ICON[g.kind]" class="icon"
        /></span>
        <span class="font-medium">{{ g.label }}</span>
        <span class="font-mono text-xs text-zinc-400">{{ g.items.length }}</span>
        <RouterLink :to="g.all" class="ml-auto shrink-0 text-xs text-zinc-500 hover:text-violet-500"
          >{{ g.allLabel }} <NextIcon class="icon-sm"
        /></RouterLink>
        <p class="w-full text-xs text-zinc-500">{{ g.blurb }}</p>
      </div>
      <template
        v-for="(d, i) in expanded.has(g.kind) ? g.items : g.items.slice(0, FIRST)"
        :key="d.id"
      >
        <!-- site text is read chapter by chapter, under the chapter's name -->
        <div
          v-if="g.kind === 'sitetext' && opensChapter(g.items, i)"
          class="border-b border-zinc-100 bg-zinc-50 px-4 py-1 text-[11px] font-medium text-zinc-500 dark:border-zinc-800/70 dark:bg-zinc-800/30"
        >
          {{ d.where }}
        </div>
        <div
          class="relative flex items-start border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50 dark:border-zinc-800/70 dark:hover:bg-zinc-800/40"
        >
          <span class="absolute inset-y-0 left-0 w-0.5" :class="BAR[g.tone]"></span>
          <RouterLink :to="d.to" class="flex min-w-0 flex-1 items-start gap-3 py-2.5 pl-5 pr-4">
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium">{{ d.title }}</div>
              <div class="mt-0.5 text-xs text-zinc-500">
                <span v-if="g.kind !== 'sitetext'" class="text-zinc-400">{{ d.where }} · </span
                >{{ d.detail }}
              </div>
            </div>
            <span class="shrink-0 whitespace-nowrap pt-0.5 text-[11px] text-zinc-400">
              <span v-if="d.at">{{ relative(d.at, now) }} · </span>open
              <NextIcon class="icon-sm" />
            </span>
          </RouterLink>
          <!-- settled here, with the Undo the reader's buttons give -->
          <div v-if="d.siteCheck" class="flex shrink-0 items-center gap-1 py-2.5 pr-4">
            <button
              class="btn-ghost btn-xs"
              :title="
                d.siteCheck.suggest === 'watermark'
                  ? 'Mark it as site text — kept in the script, left out of the audio'
                  : 'Read it as narration'
              "
              @click="
                scriptsStore.acceptSiteCheck(bookId, d.siteCheck.chapterId, d.siteCheck.segmentId)
              "
            >
              Accept
            </button>
            <button
              class="btn-ghost btn-xs"
              title="Leave the line as it is and drop the suggestion"
              @click="
                scriptsStore.dismissSiteCheck(bookId, d.siteCheck.chapterId, d.siteCheck.segmentId)
              "
            >
              Dismiss
            </button>
          </div>
        </div>
      </template>
      <button
        v-if="g.items.length > FIRST && !expanded.has(g.kind)"
        class="w-full px-4 py-2 text-left text-xs text-zinc-500 hover:text-violet-500"
        @click="expand(g.kind)"
      >
        Show the other {{ g.items.length - FIRST }}
      </button>
    </section>
  </div>
</template>
