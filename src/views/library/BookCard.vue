<script setup lang="ts">
// One book on the shelf. The cover opens the overview; under it, the one next thing to do, how far
// along the book is in one bar — the counts behind it appear on hover and not otherwise — what is
// running or broken, and the audiobook built from it with what has changed since. The numbers sit outside the button, so a screen reader hears them as
// text rather than as part of "Open …".
import { computed, ref } from "vue";
import { hours, plural, TONE } from "@/views/library/shared";
import { useBookFacts } from "@/views/library/bookFacts";
import BookMenu from "@/views/library/BookMenu.vue";
import BookCover from "@/components/BookCover.vue";
import type { Book } from "@/types";
import type { PickedFile } from "@/components/addEpub";
import { ArrowRight as GoIcon } from "@lucide/vue";

const props = defineProps<{ book: Book }>();
const emit = defineEmits<{ open: []; addVolume: [picked: PickedFile] }>();

const id = computed(() => props.book.id);
const f = useBookFacts(id);
const p = computed(() => f.value.progress);
const contents = computed(() => f.value.contents);
const next = computed(() => f.value.next);

/** The bar: narrated, scripted-but-not-narrated, untouched, skipped — of every chapter in the book. */
const segments = computed(() => {
  const all = contents.value.total || 1;
  const narrated = p.value.narrated;
  const scripted = Math.max(0, p.value.scripted - narrated);
  const untouched = Math.max(0, p.value.total - p.value.scripted);
  const skipped = p.value.excluded;
  const pct = (n: number) => `${(n / all) * 100}%`;
  return [
    { key: "narrated", n: narrated, w: pct(narrated), cls: "bg-sky-500", word: "narrated" },
    { key: "scripted", n: scripted, w: pct(scripted), cls: "bg-amber-500", word: "scripted" },
    {
      key: "untouched",
      n: untouched,
      w: pct(untouched),
      cls: "bg-zinc-200 dark:bg-zinc-700",
      word: "not started",
    },
    {
      key: "skipped",
      n: skipped,
      w: pct(skipped),
      cls: "bg-[repeating-linear-gradient(135deg,transparent_0_3px,rgb(161_161_170/0.6)_3px_5px)]",
      word: "skipped",
    },
  ];
});
const sentence = computed(() => {
  const parts = segments.value.filter((s) => s.n).map((s) => `${s.n} ${s.word}`);
  if (p.value.stale) parts.push(`${p.value.stale} stale`);
  return parts.join(" · ");
});

/**
 * What the bar is made of, shown while the pointer or the focus is on it and not otherwise. Built
 * in the card rather than from a portal: a closed popover left inside a card that a search then
 * narrows away has frozen the renderer before (see BookMenu).
 */
const hover = ref(false);
const details = computed(() => {
  const x = f.value;
  const rows = [
    {
      key: "scripted",
      label: "Scripted",
      value: `${p.value.scripted} of ${p.value.total}`,
      note: x.failedScripting ? `${x.failedScripting} failed` : "",
      dot: "bg-amber-500",
    },
    {
      key: "narrated",
      label: "Narrated",
      value: `${p.value.narrated} of ${p.value.total}`,
      note: p.value.stale
        ? `${p.value.stale} stale`
        : x.failedNarration
          ? `${x.failedNarration} failed`
          : "",
      dot: "bg-sky-500",
    },
    {
      key: "audiobook",
      label: "In audiobook",
      value: x.latest ? `${x.latest.chapterIds.length} of ${p.value.total}` : "none yet",
      note: x.latest ? `v${x.latest.version}` : "",
      dot: "bg-violet-500",
    },
  ];
  if (p.value.excluded)
    rows.push({
      key: "skipped",
      label: "Skipped",
      value: `${p.value.excluded}`,
      note: "kept in the book",
      dot: "bg-zinc-400",
    });
  return rows;
});

/** The audiobook built from it: version and length, and whether it still matches the book. */
const audiobook = computed(() => {
  const x = f.value;
  if (x.latest)
    return {
      value: `Audiobook v${x.latest.version} · ${hours(x.latest.duration)}`,
      note: x.behind ? x.behindWhy || "needs an update" : "up to date",
      cls: x.behind
        ? "text-amber-600 dark:text-amber-400"
        : "text-emerald-700 dark:text-emerald-400",
    };
  if (x.building) return { value: "Building the first audiobook…", note: "", cls: "" };
  return { value: "No audiobook yet", note: "", cls: "" };
});
</script>

<template>
  <article
    class="card group relative flex flex-col overflow-hidden transition-shadow hover:shadow-lg hover:shadow-violet-500/10 focus-within:ring-2 focus-within:ring-violet-400"
    :aria-label="book.title"
  >
    <button
      class="relative block w-full text-left focus-visible:outline-none"
      :aria-label="`Open ${book.title}`"
      data-card-open
      @click="emit('open')"
    >
      <BookCover :book="book" class="aspect-[4/5] p-4">
        <!-- a soft vignette so white text reads on the paler covers -->
        <div
          class="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/35 via-transparent to-black/10"
        ></div>
        <div class="relative pr-6">
          <div class="font-serif text-lg font-semibold leading-tight text-white drop-shadow">
            {{ book.title }}
          </div>
          <div class="mt-1 text-xs text-white/85">{{ book.author }}</div>
        </div>
        <div
          class="absolute inset-x-0 bottom-0 flex items-center justify-between px-4 pb-3 text-[11px] text-white/90"
        >
          <span
            >{{ plural(contents.included, "chapter")
            }}<span v-if="book.volumes.length > 1"> · {{ book.volumes.length }} vols</span
            ><span v-if="contents.skipped"> · {{ contents.skipped }} skipped</span></span
          >
          <span
            class="translate-y-1 opacity-0 transition-all group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"
            >Open <GoIcon class="icon-sm"
          /></span>
        </div>
      </BookCover>
    </button>

    <!-- the per-book menu sits over the cover, out of the open button -->
    <BookMenu
      :book="book"
      trigger-class="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/25 text-white opacity-0 backdrop-blur transition-opacity hover:bg-black/40 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white group-hover:opacity-100 data-[state=open]:opacity-100"
      @add-volume="(picked) => emit('addVolume', picked)"
    />

    <div class="flex flex-1 flex-col gap-2 p-2.5 text-xs">
      <RouterLink
        :to="`/book/${book.id}/${next.to}`"
        class="flex items-center justify-between rounded-md border px-2.5 py-1.5 font-medium transition-colors"
        :class="TONE[next.tone]"
      >
        <span>{{ next.label }}</span
        ><GoIcon class="icon-sm opacity-70" />
      </RouterLink>

      <!-- one bar; what it is made of appears while the pointer or the focus is on it -->
      <div class="relative">
        <div
          class="flex h-1.5 cursor-help overflow-hidden rounded-full bg-zinc-200 transition-[height] hover:h-2 dark:bg-zinc-800"
          role="img"
          tabindex="0"
          :aria-label="sentence"
          @mouseenter="hover = true"
          @mouseleave="hover = false"
          @focus="hover = true"
          @blur="hover = false"
        >
          <div
            v-for="s in segments"
            :key="s.key"
            class="h-full transition-[width]"
            :class="s.cls"
            :style="{ width: s.w }"
          ></div>
        </div>
        <Transition
          enter-active-class="transition duration-150 ease-out"
          enter-from-class="translate-y-1 opacity-0"
          leave-active-class="transition duration-100 ease-in"
          leave-to-class="translate-y-1 opacity-0"
        >
          <dl
            v-if="hover"
            class="pointer-events-none absolute bottom-full left-0 z-10 mb-2 w-full rounded-md bg-zinc-900 px-2.5 py-2 text-[11px] leading-snug text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900"
            aria-hidden="true"
          >
            <div
              v-for="d in details"
              :key="d.key"
              class="flex items-baseline justify-between gap-2 py-px"
            >
              <dt class="flex items-center gap-1.5 opacity-80">
                <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="d.dot"></span>{{ d.label }}
              </dt>
              <dd class="text-right">
                {{ d.value }}<span v-if="d.note" class="opacity-60"> · {{ d.note }}</span>
              </dd>
            </div>
          </dl>
        </Transition>
      </div>

      <div v-if="f.activity || f.failedJobs" class="leading-snug">
        <RouterLink
          v-if="f.activity"
          to="/queue"
          class="flex items-center gap-1.5 text-emerald-700 hover:underline dark:text-emerald-300"
        >
          <span class="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"></span>
          {{ f.activity }}
        </RouterLink>
        <RouterLink
          v-if="f.failedJobs"
          to="/queue"
          class="flex items-center gap-1.5 text-red-600 hover:underline dark:text-red-400"
        >
          <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500"></span>
          {{ plural(f.failedJobs, "job") }} failed · see the queue
        </RouterLink>
      </div>

      <RouterLink
        :to="`/book/${book.id}/export?tab=library`"
        class="mt-auto block leading-snug text-zinc-500 hover:underline"
      >
        <span class="text-zinc-700 dark:text-zinc-200">{{ audiobook.value }}</span>
        <div v-if="audiobook.note" class="text-[11px]" :class="audiobook.cls">
          {{ audiobook.note }}
        </div>
      </RouterLink>
    </div>
  </article>
</template>
