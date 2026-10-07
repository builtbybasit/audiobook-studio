<script setup lang="ts">
// Contents review, in three tabs: "To decide" is an inbox of only the chapters the import flagged;
// "All chapters" the whole list, searched and filtered, read on the right; "Volumes" where the
// book is cut. The state and every action live in useContents.ts; this is the frame around them —
// the header with the import's buttons, the tab row, the reader beside the first two tabs (a
// bottom sheet on a phone).
import { nextTick, onMounted, ref } from "vue";
import { DialogTitle, TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import { plural } from "@/lib/contents";
import { TABS, useContents } from "@/views/contents/useContents";
import ContentsInbox from "@/views/contents/ContentsInbox.vue";
import ContentsList from "@/views/contents/ContentsList.vue";
import ContentsPreview from "@/views/contents/ContentsPreview.vue";
import ContentsVolumes from "@/views/contents/ContentsVolumes.vue";
import { FILTER_KEYS, FILTER_LABEL } from "@/views/contents/shared";
import { UiSheet } from "@/ui";
import { BookOpen as ReadIcon, Search as SearchIcon, X as ClearIcon } from "@lucide/vue";

const p = useContents();
const { bookId, libraryStore } = p;
const search = ref<HTMLInputElement | null>(null);
const list = ref<InstanceType<typeof ContentsList> | null>(null);
const cancelling = ref(false);

onMounted(async () => {
  await nextTick();
  if (p.opened.value != null)
    document
      .getElementById(`contents-${bookId}-${p.opened.value}`)
      ?.scrollIntoView({ block: "center" });
});

async function nextUndecided() {
  const c = p.nextUndecided();
  if (!c) return;
  await nextTick();
  await list.value?.focusRow(c.id, c.volumeId);
}
async function closeSheet() {
  const id = p.opened.value;
  p.opened.value = null;
  await nextTick();
  if (id != null) document.getElementById(`contents-${bookId}-${id}`)?.focus();
}
async function discard() {
  if (await p.discard()) cancelling.value = false;
}
</script>

<template>
  <div v-if="p.book.value" class="flex h-full min-h-0 flex-col">
    <!-- header: what book, what this review is for, and the button that adds it -->
    <div
      class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-200 bg-white px-4 py-2.5 sm:px-6 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-2">
          <h1 class="truncate font-serif text-lg leading-tight">{{ p.book.value.title }}</h1>
          <span class="truncate text-xs text-zinc-500"
            >{{ p.book.value.author }} · {{ plural(p.summary.value.total, "chapter") }}
            <template v-if="p.multi.value"> · {{ p.volumes.value.length }} volumes</template></span
          >
        </div>
        <div class="text-[11px] text-zinc-500">
          <template v-if="p.importing.value === 'book'"
            >Reviewing before adding to the library</template
          >
          <template v-else-if="p.importing.value === 'volume'"
            >Reviewing {{ p.newVolume.value?.name }} before adding it</template
          >
          <template v-else>Contents · changes apply now</template>
        </div>
      </div>
      <template v-if="p.importing.value">
        <template v-if="cancelling">
          <span class="text-xs text-zinc-500">Discard? Nothing was added.</span>
          <button class="btn-ghost btn-xs" @click="cancelling = false">Keep reviewing</button>
          <button
            class="rounded-md bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-500"
            @click="discard"
          >
            Discard
          </button>
        </template>
        <template v-else>
          <button class="btn-ghost btn-xs" @click="cancelling = true">
            {{ p.importing.value === "book" ? "Cancel import" : "Don’t add this volume" }}
          </button>
          <button
            class="btn-primary"
            :disabled="!p.included.value"
            :title="!p.included.value ? 'Include at least one chapter' : ''"
            @click="p.confirm()"
          >
            {{ p.actionLabel.value }}
          </button>
        </template>
      </template>
      <RouterLink v-else :to="`/book/${bookId}`" class="btn-ghost btn-xs">Overview</RouterLink>
    </div>

    <TabsRoot v-model="p.tab.value" class="flex min-h-0 flex-1 flex-col">
      <TabsList
        class="flex shrink-0 items-center gap-1 border-b border-zinc-200 bg-white px-4 sm:px-6 dark:border-zinc-800 dark:bg-zinc-900"
      >
        <TabsTrigger
          v-for="t in TABS"
          :key="t.value"
          :value="t.value"
          class="flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm text-zinc-500 transition-colors hover:text-zinc-800 data-[state=active]:border-violet-500 data-[state=active]:font-semibold data-[state=active]:text-zinc-900 dark:hover:text-zinc-200 dark:data-[state=active]:text-zinc-100"
        >
          {{ t.label }}
          <span
            class="rounded-full px-1.5 font-mono text-[10px]"
            :class="
              t.value === 'decide' && p.undecided.value.length
                ? 'bg-amber-400/20 text-amber-700 dark:text-amber-300'
                : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800'
            "
            >{{
              t.value === "decide"
                ? p.undecided.value.length
                : t.value === "all"
                  ? p.summary.value.total
                  : p.volumes.value.length
            }}</span
          >
        </TabsTrigger>
        <span class="ml-auto text-xs text-zinc-500" aria-live="polite"
          ><b>{{ p.summary.value.included }}</b> of {{ p.summary.value.total }} go in</span
        >
      </TabsList>

      <TabsContent value="volumes" class="min-h-0 flex-1 overflow-auto">
        <ContentsVolumes :page="p" />
      </TabsContent>

      <!-- the first two tabs share the reader on the right -->
      <div
        v-if="p.tab.value !== 'volumes'"
        class="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(340px,44%)]"
      >
        <TabsContent
          value="decide"
          class="flex min-h-0 flex-col border-r border-zinc-200 dark:border-zinc-800"
        >
          <ContentsInbox :page="p" />
        </TabsContent>

        <TabsContent
          value="all"
          class="flex min-h-0 flex-col border-r border-zinc-200 dark:border-zinc-800"
        >
          <div
            class="flex shrink-0 flex-wrap items-center gap-1 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800"
            role="group"
            aria-label="Find and filter chapters"
          >
            <div class="input flex min-w-40 flex-1 items-center gap-1 py-0.5">
              <SearchIcon class="icon-sm shrink-0 text-zinc-400" />
              <input
                ref="search"
                v-model="p.q.value"
                class="min-w-0 flex-1 bg-transparent py-0.5 text-xs focus:outline-none"
                placeholder="Find a chapter… (title, number or reason)"
                aria-label="Find a chapter"
              />
              <button
                v-if="p.q.value"
                class="text-zinc-400 hover:text-zinc-600"
                aria-label="Clear the search"
                @click="p.q.value = ''"
              >
                <ClearIcon class="icon-sm" />
              </button>
            </div>
            <button
              v-for="f in FILTER_KEYS"
              :key="f"
              class="chip"
              :class="[
                p.filter.value === f && !p.kind.value && 'chip-on',
                f === 'suggested' &&
                  p.filterCounts.value[f] &&
                  p.filter.value !== f &&
                  'border-amber-400 text-amber-600 dark:text-amber-400',
                f === 'review' &&
                  p.filterCounts.value[f] &&
                  p.filter.value !== f &&
                  'border-violet-400 text-violet-600 dark:text-violet-400',
              ]"
              :aria-pressed="p.filter.value === f && !p.kind.value"
              :disabled="f !== 'all' && !p.filterCounts.value[f]"
              @click="p.setFilter(f)"
            >
              {{ FILTER_LABEL[f] }}
              <span class="font-mono opacity-60">{{ p.filterCounts.value[f] }}</span>
            </button>
            <button
              v-if="p.kind.value"
              class="chip chip-on"
              :aria-pressed="true"
              @click="p.kind.value = null"
            >
              {{ p.groups.value.find((g) => g.kind === p.kind.value)?.label ?? p.kind.value }}
              <ClearIcon class="icon-sm" />
            </button>
          </div>

          <ContentsList
            ref="list"
            :book-id="bookId"
            :rows="p.rows.value"
            :multi="p.multi.value"
            :opened="p.opened.value"
            :collapsed="p.collapsed.value"
            :text-of="p.textOf"
            :narrowed="p.narrowed.value"
            @open="p.open"
            @toggle="p.toggle"
            @toggle-volume="p.toggleVolume"
            @update:collapsed="(v) => (p.collapsed.value = v)"
            @next-undecided="nextUndecided"
            @search="search?.focus()"
          />
          <p v-if="!p.visible.value.length" class="px-3 py-8 text-center text-xs text-zinc-500">
            <template v-if="p.q.value">No chapter matches “{{ p.q.value }}”.</template>
            <template v-else-if="p.kind.value">No chapter with this note is left to show.</template>
            <template v-else>Nothing is {{ FILTER_LABEL[p.filter.value].toLowerCase() }}.</template>
            <button class="ml-1 underline" @click="p.showEverything()">Show everything</button>
          </p>
          <div
            v-if="p.narrowed.value && p.visible.value.length"
            class="shrink-0 border-t border-zinc-200 px-3 py-1.5 text-[11px] text-zinc-500 dark:border-zinc-800"
          >
            Showing {{ p.visible.value.length }} of {{ p.summary.value.total }} chapters ·
            <button class="underline" @click="p.showEverything()">show everything</button>
          </div>
        </TabsContent>

        <!-- the chapter being read (wide screens) -->
        <aside class="hidden min-h-0 lg:block" aria-label="Chapter">
          <ContentsPreview
            v-if="p.wide.value && p.openedChapter.value"
            :key="p.openedChapter.value.id"
            :chapter="p.openedChapter.value"
            :volume="libraryStore.volumeOf(bookId, p.openedChapter.value.id)"
            :multi="p.multi.value"
            :number="p.numbers.value?.get(p.openedChapter.value.id)"
            :kept="p.summary.value.included"
            :parts="p.openedParts.value"
            :undecided-left="p.undecidedAfter.value"
            @skip="p.skipOne(p.openedChapter.value.id)"
            @include="p.includeOne(p.openedChapter.value.id)"
            @keep="p.keepOne(p.openedChapter.value.id)"
            @prev="p.step(-1)"
            @next="p.step(1)"
            @next-undecided="nextUndecided"
          />
          <div v-else class="grid h-full place-items-center p-8 text-center text-sm text-zinc-500">
            <div>
              <ReadIcon class="mx-auto mb-2 h-6 w-6 text-zinc-300 dark:text-zinc-600" />
              Open a chapter to read it in full.
            </div>
          </div>
        </aside>
      </div>
    </TabsRoot>

    <!-- narrow screens: the chapter opens as a sheet over the list -->
    <UiSheet
      v-if="!p.wide.value"
      side="bottom"
      :open="!!p.openedChapter.value"
      class="h-[88dvh]"
      :aria-describedby="undefined"
      @update:open="(v) => !v && closeSheet()"
    >
      <DialogTitle class="sr-only">{{ p.openedChapter.value?.title }}</DialogTitle>
      <ContentsPreview
        v-if="p.openedChapter.value"
        :key="p.openedChapter.value.id"
        :chapter="p.openedChapter.value"
        :volume="libraryStore.volumeOf(bookId, p.openedChapter.value.id)"
        :multi="p.multi.value"
        :number="p.numbers.value?.get(p.openedChapter.value.id)"
        :kept="p.summary.value.included"
        :parts="p.openedParts.value"
        :undecided-left="p.undecidedAfter.value"
        sheet
        @skip="p.skipOne(p.openedChapter.value.id)"
        @include="p.includeOne(p.openedChapter.value.id)"
        @keep="p.keepOne(p.openedChapter.value.id)"
        @prev="p.step(-1)"
        @next="p.step(1)"
        @next-undecided="nextUndecided"
        @close="closeSheet"
      />
    </UiSheet>
  </div>
</template>
