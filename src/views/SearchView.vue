<script setup lang="ts">
// Script search across every scripted chapter of the book: text, speaker, direction. Results open the
// reader at that exact segment.
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useApp, isScripted } from "@/stores/app";
import { UiSelect, UiToggleGroup } from "@/ui";
import { useFilter } from "reka-ui";
import { useBookId } from "@/router";
const app = useApp();
const route = useRoute();
const router = useRouter();
const bookId = useBookId();
const q = ref(String(route.query.q ?? ""));
const speaker = ref("");
const type = ref("all");
watch(
  () => route.query.q,
  (v) => {
    if (v != null) q.value = String(v);
  },
);
watch(q, (v) => router.replace({ query: { ...route.query, q: v || undefined } }));
const { contains } = useFilter({ sensitivity: "base" });
const cast = computed(() => app.charactersOf(bookId));
const speakerOpts = computed(() => [
  { value: "", label: "Any speaker" },
  ...cast.value.map((c) => ({ value: c.name, label: c.name, color: c.color })),
]);
const results = computed(() => {
  const s = q.value.trim();
  const out = [];
  for (const c of app.chaptersOf(bookId).filter(isScripted)) {
    const hits = app
      .segmentsOf(bookId, c.id)
      .filter(
        (x) =>
          (!speaker.value || x.speaker === speaker.value) &&
          (type.value === "all" || x.type === type.value) &&
          (!s || contains(x.text, s) || contains(x.direction ?? "", s) || contains(x.speaker, s)),
      );
    if (hits.length) out.push({ chapter: c, hits });
  }
  return out;
});
const total = computed(() => results.value.reduce((a, r) => a + r.hits.length, 0));
function mark(text: string): { t: string; hit?: boolean }[] {
  const s = q.value.trim();
  if (!s) return [{ t: text }];
  const parts: { t: string; hit?: boolean }[] = [];
  let i = 0;
  const lower = text.toLowerCase(),
    needle = s.toLowerCase();
  while (i < text.length) {
    const j = lower.indexOf(needle, i);
    if (j < 0) {
      parts.push({ t: text.slice(i) });
      break;
    }
    if (j > i) parts.push({ t: text.slice(i, j) });
    parts.push({ t: text.slice(j, j + s.length), hit: true });
    i = j + s.length;
  }
  return parts;
}
const colorOf = (n: string) => cast.value.find((c) => c.name === n)?.color ?? "#71717a";
</script>
<template>
  <div class="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
    <div>
      <h1 class="text-2xl font-semibold">Search the script</h1>
      <p class="text-sm text-zinc-500">
        Every line of {{ app.bookById(bookId)?.title }} that has been scripted — text, speaker or
        direction.
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <input
        v-model="q"
        class="input min-w-[200px] flex-1"
        placeholder="Search text, a speaker, or a direction…"
        autofocus
      />
      <UiSelect v-model="speaker" :options="speakerOpts" class="w-44" />
      <UiToggleGroup
        v-model="type"
        :options="[
          { value: 'all', label: 'all' },
          { value: 'dialogue', label: 'dialogue' },
          { value: 'narration', label: 'narration' },
          { value: 'thought', label: 'thought' },
        ]"
      />
    </div>
    <div class="text-xs text-zinc-500">
      {{ total }} line{{ total === 1 ? "" : "s" }} in {{ results.length }} chapter{{
        results.length === 1 ? "" : "s"
      }}
    </div>
    <div v-for="r in results" :key="r.chapter.id" class="card">
      <RouterLink
        :to="{ path: `/book/${bookId}/scripting`, query: { ch: r.chapter.id } }"
        class="flex items-center gap-2 border-b border-zinc-200 px-4 py-2 text-sm hover:text-violet-500 dark:border-zinc-800"
        ><span class="font-mono text-xs text-zinc-400">{{
          String(r.chapter.id).padStart(2, "0")
        }}</span
        ><b>{{ r.chapter.title }}</b
        ><span class="ml-auto text-xs text-zinc-400">{{ r.hits.length }}</span></RouterLink
      >
      <RouterLink
        v-for="s in r.hits.slice(0, 50)"
        :key="s.id"
        :to="{ path: `/book/${bookId}/scripting`, query: { ch: r.chapter.id, seg: s.id } }"
        class="flex items-start gap-3 border-b border-zinc-100 px-4 py-2 text-sm last:border-0 hover:bg-zinc-50 dark:border-zinc-800/70 dark:hover:bg-zinc-800/50"
      >
        <span
          class="mt-0.5 shrink-0 rounded-full px-2 text-xs"
          :style="{ background: colorOf(s.speaker) + '33', color: colorOf(s.speaker) }"
          >{{ s.speaker }}</span
        >
        <span class="min-w-0 flex-1" :class="s.type === 'thought' && 'italic'"
          ><template v-for="(p, i) in mark(s.text)" :key="i"
            ><mark v-if="p.hit" class="rounded bg-amber-300/60 px-0.5 dark:bg-amber-500/40">{{
              p.t
            }}</mark
            ><template v-else>{{ p.t }}</template></template
          ><span v-if="s.direction" class="ml-2 text-[11px] text-violet-500"
            >[{{ s.direction }}]</span
          ></span
        >
        <span class="font-mono text-[10px] text-zinc-400">#{{ s.id }}</span>
      </RouterLink>
      <div v-if="r.hits.length > 50" class="px-4 py-1 text-[11px] text-zinc-400">
        +{{ r.hits.length - 50 }} more in this chapter
      </div>
    </div>
    <div v-if="!results.length" class="card p-8 text-center text-sm text-zinc-500">
      {{ q ? `Nothing matches “${q}”.` : "Type to search." }}
    </div>
  </div>
</template>
