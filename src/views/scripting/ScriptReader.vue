<script setup>
// Script reader: narration flows as prose; dialogue and thought are lifted into cards with a
// speaker pill and the voice direction. Right rail (toggleable) = the cast *in this chapter* with
// aliases, spoiler-hidden descriptions and inline rename/merge; the rest of the cast is collapsed.
// Any segment can be clicked to edit speaker / type / direction in place. Typography via the Aa menu.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useScript, TYPES } from "./shared";
import { DIRECTIONS } from "../../mock/data";
import { useReader } from "../../stores/reader";
import ReaderSettings from "../../components/ReaderSettings.vue";
import { UiSelect, UiCombobox, UiToggleGroup, UiTooltip, UiSwitch } from "../../ui";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
const typeOpts = TYPES.map((t) => ({ value: t, label: t }));
const speakerOpts = computed(() => [
  ...inChapter.value.map((c) => ({
    value: c.name,
    label: c.name,
    color: c.color,
    group: "In this chapter",
    hint: counts.value[c.name] + " lines",
    keywords: c.aliases.join(" "),
  })),
  ...rest.value.map((c) => ({
    value: c.name,
    label: c.name,
    color: c.color,
    group: "Rest of cast",
    keywords: c.aliases.join(" "),
  })),
]);
const filterOpts = computed(() => [
  { value: "", label: "All speakers" },
  ...inChapter.value.map((c) => ({
    value: c.name,
    label: c.name,
    color: c.color,
    hint: counts.value[c.name] + "",
  })),
]);

const props = defineProps({ bookId: String, chapterId: Number });
const { app, segments, cast, counts, inChapter, colorOf } = useScript(props);
const reader = useReader();
const volume = computed(() => app.volumeOf(props.bookId, props.chapterId));
const multiVolume = computed(() => app.volumesOf(props.bookId).length > 1);

const mode = ref("all"); // all | dialogue
const speaker = ref(""); // '' = everyone
const open = ref(null);
const showRest = ref(false);
const revealed = ref(new Set());
const editingName = ref(null);
const draft = ref("");

const rows = computed(() =>
  segments.value.filter(
    (s) =>
      (mode.value === "all" || s.type !== "narration") &&
      (!speaker.value || s.speaker === speaker.value),
  ),
);
const rest = computed(() => cast.value.filter((c) => !counts.value[c.name]));
const chapter = computed(() => app.chapter(props.bookId, props.chapterId));
const chars = computed(() => segments.value.reduce((a, s) => a + s.text.length, 0));

function jumpToSpeaker(name) {
  speaker.value = speaker.value === name ? "" : name;
}
function startRename(c) {
  editingName.value = c.name;
  draft.value = c.name;
}
function commitRename() {
  if (editingName.value) app.renameCharacter(props.bookId, editingName.value, draft.value);
  editingName.value = null;
}
function nextNew() {
  const s = segments.value.find((s) => cast.value.find((c) => c.name === s.speaker)?.isNew);
  if (s) {
    open.value = s.id;
    document.getElementById("seg-" + s.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}
const unresolved = computed(() => inChapter.value.filter((c) => c.isNew).length);
const fallbacks = computed(() => segments.value.filter((s) => s.fallback));
const route = useRoute();

// directions: presets + everything already used in this book, free text allowed
const dirOpts = computed(() => {
  const used = new Map();
  for (const k of Object.keys(app.segments))
    if (k.startsWith(props.bookId + ":"))
      for (const x of app.segments[k])
        if (x.direction) used.set(x.direction, (used.get(x.direction) ?? 0) + 1);
  const fromBook = [...used.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([d, n]) => ({ value: d, label: d, group: "Used in this book", hint: n + "×" }));
  return [
    ...fromBook,
    ...DIRECTIONS.filter((d) => !used.has(d)).map((d) => ({
      value: d,
      label: d,
      group: "Presets",
    })),
  ];
});
const sameSpeakerCount = (s) =>
  segments.value.filter((x) => x.speaker === s.speaker && x.id !== s.id).length;

// stale nudge: lines edited after narration, whose audio is now out of date
const stale = computed(() => segments.value.filter((s) => s.audio.status === "stale").length);
const edits = computed(() => segments.value.filter((s) => s.edited).length);

// re-script: run the LLM again on this chapter, optionally re-applying manual edits; then show the diff
const rescriptOpen = ref(false);
const keepEdits = ref(true);
const diff = computed(() => app.scriptDiff(props.bookId, props.chapterId));
const showDiff = ref(true);
function rescript() {
  rescriptOpen.value = false;
  app.runScripting(props.bookId, [props.chapterId], { keepEdits: keepEdits.value });
}
function jumpTo(id) {
  focus.value = id;
  open.value = null;
  nextTick(() =>
    document.getElementById("seg-" + id)?.scrollIntoView({ block: "center", behavior: "smooth" }),
  );
}

// keyboard: j/k or ↑/↓ move, Enter edit, Esc close, 1–9 assign speaker (in-chapter order), c toggles cast
const focus = ref(null);
function moveFocus(d) {
  const ids = rows.value.map((r) => r.id);
  const i = ids.indexOf(focus.value);
  focus.value = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + d))] ?? null;
  document
    .getElementById("seg-" + focus.value)
    ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function onKey(e) {
  const t = e.target;
  // inside a field: let the widget (combobox/select) handle Escape itself; a second Escape closes the editor
  if (
    ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) ||
    t.isContentEditable ||
    t.closest?.("[role=listbox],[role=option]")
  ) {
    if (e.key === "Escape" && t.getAttribute("role") !== "combobox") t.blur();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "j") {
    e.preventDefault();
    moveFocus(1);
  } else if (e.key === "ArrowUp" || e.key === "k") {
    e.preventDefault();
    moveFocus(-1);
  } else if (e.key === "Enter" && focus.value) {
    open.value = open.value === focus.value ? null : focus.value;
  } else if (e.key === "Escape") {
    open.value = null;
  } else if (e.key === "c") {
    reader.showCast = !reader.showCast;
  } else if (e.key === "/" && !e.shiftKey) {
    e.preventDefault();
    document.querySelector('input[placeholder^="Find chapter"]')?.focus();
  } else if (/^[1-9]$/.test(e.key) && focus.value) {
    const c = inChapter.value[Number(e.key) - 1];
    if (c) app.setSpeaker(props.bookId, props.chapterId, focus.value, c.name);
  }
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
  if (route.query.seg) jumpTo(Number(route.query.seg));
});
onUnmounted(() => window.removeEventListener("keydown", onKey));
watch(
  () => route.query.seg,
  (v) => {
    if (v) jumpTo(Number(v));
  },
);
watch(open, (v) => {
  if (v) focus.value = v;
});
</script>

<template>
  <div
    class="grid h-full gap-4"
    :class="reader.showCast ? 'lg:grid-cols-[1fr_300px]' : 'grid-cols-1'"
  >
    <!-- reader -->
    <div class="card flex min-h-0 min-w-0 flex-col">
      <div class="border-b border-zinc-200 px-4 pb-3 pt-4 sm:px-6 dark:border-zinc-800">
        <div class="flex flex-wrap items-start gap-2">
          <div class="min-w-[200px] flex-1">
            <div class="label">
              <span v-if="multiVolume">{{ volume?.name }} · </span>Chapter {{ chapter.id
              }}<span
                v-if="multiVolume"
                class="font-normal normal-case tracking-normal text-zinc-400"
              >
                (ch. {{ chapter.volumeIndex }} of this volume)</span
              >
            </div>
            <h2 class="truncate font-serif text-2xl">{{ chapter.title }}</h2>
            <div class="mt-0.5 text-xs text-zinc-500">
              {{ segments.length }} segments · {{ inChapter.length }} speakers ·
              {{ (chars / 1000).toFixed(1) }}k chars ·
              <span class="font-mono">chapter_{{ String(chapter.id).padStart(3, "0") }}.json</span>
            </div>
          </div>
          <button
            v-if="unresolved"
            class="btn-ghost btn-xs border-amber-400 text-amber-600"
            @click="nextNew"
          >
            ⚠ {{ unresolved }} unreviewed speaker{{ unresolved > 1 ? "s" : "" }} → jump
          </button>
          <PopoverRoot v-model:open="rescriptOpen">
            <PopoverTrigger class="btn-ghost btn-xs" title="run the LLM again on this chapter"
              >↻ Re-script</PopoverTrigger
            >
            <PopoverPortal>
              <PopoverContent :side-offset="6" align="end" class="ui-popup w-80 p-3 text-xs">
                <div class="label mb-2">Re-script chapter {{ chapter.id }}</div>
                <div class="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
                  <span class="text-zinc-500">Profile</span
                  ><UiSelect
                    v-model="app.scriptSettings.profile"
                    :options="
                      app.profiles.map((p) => ({ value: p.id, label: p.name, hint: p.model }))
                    "
                    size="xs"
                    block
                  />
                  <span class="text-zinc-500">Chunk</span>
                  <div class="flex items-center gap-2">
                    <input
                      v-model.number="app.scriptSettings.chunkChars"
                      type="number"
                      step="500"
                      min="2000"
                      class="input w-24 py-0.5 font-mono"
                    /><span class="text-zinc-400">chars</span>
                  </div>
                </div>
                <div class="mt-2 rounded-md bg-zinc-50 p-2 dark:bg-zinc-800/60">
                  <template v-if="edits"
                    ><UiSwitch
                      v-model="keepEdits"
                      :label="`keep my ${edits} manual edit${edits === 1 ? '' : 's'}`"
                    />
                    <div class="mt-1 text-[11px] text-zinc-500">
                      {{
                        keepEdits
                          ? "Speaker / type / direction you changed are re-applied where the text still matches."
                          : "Your edits are discarded — the new run wins."
                      }}
                    </div></template
                  >
                  <div v-else class="text-[11px] text-zinc-500">
                    No manual edits in this chapter.
                  </div>
                </div>
                <div class="mt-1 text-[11px] text-zinc-500">
                  <template v-if="segments.some((s) => s.audio.duration)"
                    >Narrated audio is kept; lines whose speaker or direction change become
                    stale.</template
                  >
                  A “what changed” panel appears when it finishes.
                </div>
                <div class="mt-3 flex justify-end gap-2">
                  <button class="btn-ghost btn-xs" @click="rescriptOpen = false">Cancel</button
                  ><button class="btn-primary btn-xs" @click="rescript">Re-script now</button>
                </div>
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>
          <button
            class="btn-ghost btn-xs"
            :class="reader.showCast && 'bg-zinc-200 dark:bg-zinc-800'"
            @click="reader.showCast = !reader.showCast"
          >
            ☺ Cast <span class="text-zinc-400">{{ inChapter.length }}</span>
          </button>
          <ReaderSettings />
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <UiToggleGroup
            v-model="mode"
            :options="[
              { value: 'all', label: 'Everything' },
              { value: 'dialogue', label: 'Dialogue only' },
            ]"
          />
          <UiSelect v-model="speaker" :options="filterOpts" size="xs" class="w-40" />
          <span class="ml-auto whitespace-nowrap text-[11px] text-zinc-400"
            >{{ rows.length }} shown · click any line to edit</span
          >
        </div>
      </div>

      <div
        v-if="fallbacks.length"
        class="flex items-center gap-3 border-b border-amber-300 bg-amber-400/10 px-6 py-2 text-xs text-amber-700 dark:border-amber-500/40 dark:text-amber-300"
      >
        <span>⚠</span>
        <span class="flex-1"
          ><b>{{ fallbacks.length }} chunk{{ fallbacks.length > 1 ? "s" : "" }} didn’t verify</b> —
          the model’s split couldn’t be matched back to the source text, so
          {{ fallbacks.length > 1 ? "they were" : "it was" }} kept whole and will be read by the
          Narrator. Nothing is missing from the audio, but dialogue inside won’t get character
          voices.</span
        >
        <button
          class="btn-ghost btn-xs border-amber-400"
          @click="
            document
              .getElementById('seg-' + fallbacks[0].id)
              ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            focus = fallbacks[0].id;
          "
        >
          Show
        </button>
      </div>
      <div
        v-if="stale"
        class="flex items-center gap-3 border-b border-amber-300 bg-amber-400/10 px-6 py-2 text-xs text-amber-700 dark:border-amber-500/40 dark:text-amber-300"
      >
        <span>♪</span>
        <span class="flex-1"
          ><b>{{ stale }} line{{ stale > 1 ? "s" : "" }} changed since narration</b> — the audio
          still reads the old script.</span
        >
        <RouterLink
          :to="{ path: `/book/${bookId}/narration`, query: { ch: chapterId } }"
          class="btn-primary btn-xs"
          >↻ Re-narrate changed</RouterLink
        >
      </div>
      <div
        v-if="diff && showDiff"
        class="border-b border-violet-300 bg-violet-50 px-6 py-2 text-xs dark:border-violet-500/40 dark:bg-violet-500/10"
      >
        <div class="flex items-center gap-3">
          <span class="text-violet-500">↻</span>
          <span class="flex-1"
            ><b>Re-scripted.</b> {{ diff.prevCount }} → {{ diff.curCount }} segments ·
            <b>{{ diff.speaker.length }}</b> speaker change{{
              diff.speaker.length === 1 ? "" : "s"
            }}
            · <b>{{ diff.direction.length }}</b> direction change{{
              diff.direction.length === 1 ? "" : "s"
            }}
            · <b>{{ diff.added.length }}</b> new · <b>{{ diff.removed.length }}</b> gone<span
              v-if="!diff.total"
            >
              — identical to the previous run</span
            ></span
          >
          <button
            class="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            @click="app.dismissDiff(bookId, chapterId)"
          >
            dismiss
          </button>
        </div>
        <ul v-if="diff.total" class="mt-1.5 max-h-28 space-y-0.5 overflow-auto pl-6">
          <li v-for="d in diff.speaker" :key="'s' + d.id" class="flex gap-2">
            <button class="font-mono text-violet-500 hover:underline" @click="jumpTo(d.id)">
              #{{ d.id }}</button
            ><span class="truncate"
              ><span class="text-zinc-500 line-through">{{ d.from }}</span> → <b>{{ d.to }}</b> ·
              {{ d.text.slice(0, 70) }}…</span
            >
          </li>
          <li v-for="d in diff.direction" :key="'d' + d.id" class="flex gap-2">
            <button class="font-mono text-violet-500 hover:underline" @click="jumpTo(d.id)">
              #{{ d.id }}</button
            ><span class="truncate"
              >direction <span class="text-zinc-500">{{ d.from || "—" }}</span> →
              <b>{{ d.to || "—" }}</b></span
            >
          </li>
          <li v-for="d in diff.added" :key="'a' + d.id" class="flex gap-2">
            <button class="font-mono text-emerald-600 hover:underline" @click="jumpTo(d.id)">
              #{{ d.id }}</button
            ><span class="truncate">new · {{ d.text.slice(0, 80) }}…</span>
          </li>
          <li v-for="(d, i) in diff.removed" :key="'r' + i" class="flex gap-2 text-zinc-500">
            <span class="font-mono">—</span
            ><span class="truncate">gone · {{ d.text.slice(0, 80) }}…</span>
          </li>
        </ul>
      </div>
      <div class="min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-6">
        <div
          class="mx-auto"
          :class="[reader.widthClass, reader.fontClass]"
          :style="{ fontSize: reader.size + 'px', lineHeight: reader.lineHeight }"
        >
          <template v-for="s in rows" :key="s.id">
            <!-- unverified chunk kept whole -->
            <div
              v-if="s.fallback"
              :id="'seg-' + s.id"
              class="mb-3 rounded-lg border border-dashed border-amber-400 bg-amber-400/5 px-4 py-3"
              :class="focus === s.id && 'ring-2 ring-amber-400'"
            >
              <div class="mb-1 flex items-center gap-2 font-sans text-xs leading-normal">
                <span
                  class="rounded bg-amber-400/20 px-1.5 py-0.5 font-semibold text-amber-700 dark:text-amber-300"
                  >unverified chunk · read as narration</span
                >
                <span class="text-zinc-500">~{{ s.fallbackCount }} segments collapsed</span>
                <span v-if="s.fallbackRetrying" class="ml-auto text-violet-500">re-splitting…</span>
                <button
                  v-else
                  class="btn-ghost btn-xs ml-auto"
                  @click="app.retryChunk(bookId, chapterId, s.id)"
                >
                  ↻ Re-split this chunk
                </button>
              </div>
              <p class="text-zinc-700 dark:text-zinc-300">{{ s.text }}</p>
              <details class="mt-2 font-sans text-[11px] leading-normal text-zinc-500">
                <summary class="cursor-pointer">Why it failed</summary>
                <div class="mt-1 rounded bg-white p-2 font-mono dark:bg-zinc-900">
                  verify: reconstructed text diverged near
                  <span class="bg-red-500/15 text-red-600">“{{ s.fallbackMismatch }}…”</span> after
                  2 retries → kept chunk whole (no prose dropped)
                </div>
              </details>
            </div>
            <!-- narration: plain prose -->
            <p
              v-else-if="s.type === 'narration'"
              :id="'seg-' + s.id"
              class="-mx-2 mb-3 cursor-text rounded px-2 py-0.5 transition-colors"
              :class="
                open === s.id
                  ? 'bg-violet-50 ring-1 ring-violet-300 dark:bg-violet-500/10 dark:ring-violet-500/40'
                  : focus === s.id
                    ? 'ring-1 ring-zinc-400'
                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
              "
              @click="open = open === s.id ? null : s.id"
            >
              {{ s.text
              }}<span
                v-if="s.direction"
                class="ml-2 font-sans text-[11px] leading-none text-violet-500/80"
                >[{{ s.direction }}]</span
              >
            </p>
            <!-- dialogue / thought: card -->
            <div
              v-else
              :id="'seg-' + s.id"
              class="mb-3 cursor-pointer rounded-lg border-l-[3px] bg-zinc-50 px-4 py-2.5 transition-colors dark:bg-zinc-800/50"
              :style="{ borderLeftColor: colorOf(s.speaker) }"
              :class="
                open === s.id
                  ? 'ring-1 ring-violet-300 dark:ring-violet-500/40'
                  : focus === s.id
                    ? 'ring-1 ring-zinc-400'
                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
              "
              @click="open = open === s.id ? null : s.id"
            >
              <div class="mb-1 flex items-center gap-2 font-sans text-xs leading-normal">
                <span
                  class="rounded-full px-2 py-0.5 font-medium"
                  :style="{ background: colorOf(s.speaker) + '33', color: colorOf(s.speaker) }"
                >
                  <span class="opacity-70">{{ s.type === "thought" ? "…" : "“" }}</span>
                  {{ s.speaker }}
                </span>
                <span
                  v-if="cast.find((c) => c.name === s.speaker)?.isNew"
                  class="rounded bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-600"
                  >unreviewed</span
                >
                <span
                  v-if="s.audio.status === 'stale'"
                  class="rounded bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-600"
                  title="Edited after narration — audio no longer matches"
                  >audio stale</span
                >
                <span v-if="s.direction" class="truncate italic text-zinc-500"
                  >— {{ s.direction }}</span
                >
                <span v-else class="italic text-zinc-300 dark:text-zinc-600">— no direction</span>
              </div>
              <p :class="s.type === 'thought' ? 'italic text-zinc-600 dark:text-zinc-300' : ''">
                <template v-if="s.type === 'dialogue'">‘{{ s.text }}’</template
                ><template v-else>{{ s.text }}</template>
              </p>
            </div>
            <!-- inline editor -->
            <div
              v-if="open === s.id"
              class="-mt-1 mb-4 grid grid-cols-2 items-end gap-2 rounded-md border border-violet-300 bg-white p-2 font-sans text-xs leading-normal 2xl:grid-cols-[1fr_1fr_2fr_auto] dark:border-violet-500/40 dark:bg-zinc-900"
              @click.stop
            >
              <label
                >Speaker<UiCombobox
                  :model-value="s.speaker"
                  :options="speakerOpts"
                  size="xs"
                  class="mt-1"
                  block
                  @update:model-value="(v) => app.setSpeaker(bookId, chapterId, s.id, v)"
              /></label>
              <label
                >Type<UiSelect
                  :model-value="s.type"
                  :options="typeOpts"
                  size="xs"
                  class="mt-1"
                  block
                  @update:model-value="
                    (v) => app.updateSegment(bookId, chapterId, s.id, { type: v })
                  "
              /></label>
              <label class="col-span-2 2xl:col-span-1"
                >Direction <span class="text-zinc-400">— pick or type your own</span>
                <div class="mt-1 flex items-center gap-1">
                  <UiCombobox
                    :model-value="s.direction"
                    :options="dirOpts"
                    custom
                    placeholder="e.g. whispered, hesitant"
                    size="xs"
                    class="min-w-0 flex-1"
                    block
                    @update:model-value="
                      (v) => app.updateSegment(bookId, chapterId, s.id, { direction: v })
                    "
                  />
                  <UiTooltip
                    :text="`Set “${s.direction || '—'}” on every ${s.speaker} line in this chapter (${sameSpeakerCount(s)} more)`"
                    ><button
                      class="btn-ghost btn-xs whitespace-nowrap"
                      :disabled="!s.direction || !sameSpeakerCount(s)"
                      @click="app.applyDirection(bookId, chapterId, s.speaker, s.direction)"
                    >
                      → all {{ s.speaker.split(" ")[0] }}
                    </button></UiTooltip
                  >
                </div>
              </label>
              <div class="flex items-center gap-2 justify-self-end">
                <span v-if="s.edited" class="text-[10px] text-zinc-400">edited</span
                ><button class="btn-ghost btn-xs" @click="open = null">Done</button>
              </div>
            </div>
          </template>
          <div v-if="!rows.length" class="py-10 text-center text-sm text-zinc-500">
            Nothing matches this filter.
          </div>
        </div>
      </div>
      <div
        class="hidden border-t border-zinc-200 px-6 py-1 font-sans text-[11px] text-zinc-400 xl:block dark:border-zinc-800"
      >
        <kbd class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">j</kbd>/<kbd
          class="rounded bg-zinc-100 px-1 dark:bg-zinc-800"
          >k</kbd
        >
        move · <kbd class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">↵</kbd> edit ·
        <kbd class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">1</kbd>–<kbd
          class="rounded bg-zinc-100 px-1 dark:bg-zinc-800"
          >9</kbd
        >
        assign speaker
        <span class="ml-1"
          >(<template v-for="(c, i) in inChapter.slice(0, 9)" :key="c.name"
            ><span v-if="i" class="mx-0.5">·</span><b>{{ i + 1 }}</b>
            {{ c.name.split(" ")[0] }}</template
          >)</span
        >
        · <kbd class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">c</kbd> cast
      </div>
    </div>

    <!-- cast rail -->
    <div
      v-if="reader.showCast"
      class="card max-h-[50vh] min-h-0 overflow-y-auto overflow-x-hidden p-3 lg:max-h-none"
    >
      <div class="label mb-2">In this chapter · {{ inChapter.length }} speakers</div>
      <div
        v-for="c in inChapter"
        :key="c.name"
        class="mb-2 rounded-lg border p-3 text-sm transition-colors"
        :class="[
          speaker === c.name
            ? 'border-violet-400 bg-violet-50 dark:bg-violet-500/10'
            : 'border-zinc-200 dark:border-zinc-800',
          c.isNew && 'border-dashed border-amber-400',
        ]"
      >
        <div class="flex items-center gap-2">
          <span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ background: c.color }"></span>
          <input
            v-if="editingName === c.name"
            v-model="draft"
            class="input min-w-0 flex-1 py-0"
            autofocus
            @keydown.enter="commitRename"
            @keydown.esc="editingName = null"
            @blur="commitRename"
          />
          <button
            v-else
            class="min-w-0 flex-1 truncate text-left font-semibold"
            @click="jumpToSpeaker(c.name)"
            @dblclick="startRename(c)"
          >
            {{ c.name }}
          </button>
          <span class="text-[11px] text-zinc-400">{{
            { m: "male", f: "female", n: "neutral" }[c.gender] ?? "unknown"
          }}</span>
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-1 pl-4 text-[11px] text-zinc-500">
          <span>{{ counts[c.name] }} lines</span>
          <template v-if="c.aliases.length"
            ><span>· a.k.a.</span
            ><span
              v-for="a in c.aliases"
              :key="a"
              class="rounded bg-zinc-100 px-1 dark:bg-zinc-800"
              >{{ a }}</span
            ></template
          >
          <span v-if="c.isNew" class="rounded bg-amber-400/20 px-1 font-semibold text-amber-600"
            >new · alias?</span
          >
        </div>
        <div class="mt-2 pl-4 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
          <template v-if="!c.description"
            ><span class="italic text-zinc-400">No description yet.</span></template
          >
          <template v-else-if="revealed.has(c.name) || c.name === 'Narrator'">{{
            c.description
          }}</template>
          <button
            v-else
            class="rounded border border-dashed border-zinc-300 px-2 py-1 italic text-zinc-400 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
            @click="revealed = new Set([...revealed, c.name])"
          >
            description hidden — spoilers · show
          </button>
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-1 pl-4 text-[11px]">
          <span class="mr-auto min-w-0 truncate text-zinc-500"
            >voice:
            <b class="text-zinc-700 dark:text-zinc-300">{{
              app.voiceLabel(app.effectiveVoice(bookId, c.name).ref) || "unset"
            }}</b
            ><span
              v-if="
                !app.effectiveVoice(bookId, c.name).own && app.effectiveVoice(bookId, c.name).ref
              "
            >
              (Narrator’s)</span
            ></span
          >
          <button
            class="rounded px-1.5 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            @click="startRename(c)"
          >
            rename
          </button>
          <UiCombobox
            v-if="c.name !== 'Narrator'"
            action
            :options="
              cast
                .filter((x) => x.name !== c.name)
                .map((o) => ({
                  value: o.name,
                  label: o.name,
                  color: o.color,
                  keywords: o.aliases.join(' '),
                }))
            "
            placeholder="merge into…"
            size="xs"
            class="w-28"
            @pick="(v) => app.mergeCharacter(bookId, c.name, v)"
          />
        </div>
      </div>

      <button
        class="mt-1 w-full rounded-lg border border-dashed border-zinc-300 py-2 text-xs text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
        @click="showRest = !showRest"
      >
        {{ showRest ? "Hide" : "Show" }} the rest of the cast ({{ rest.length }})
      </button>
      <div v-if="showRest" class="mt-2 space-y-0.5">
        <div
          v-for="c in rest"
          :key="c.name"
          class="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span class="h-2 w-2 rounded-full" :style="{ background: c.color }"></span>
          <span class="min-w-0 flex-1 truncate">{{ c.name }}</span>
          <span class="font-mono text-zinc-400">{{ app.lineCounts(bookId)[c.name] ?? 0 }}</span>
        </div>
      </div>
      <p class="mt-3 text-[11px] leading-relaxed text-zinc-400">
        Click a name to filter the reader to their lines. Double-click to rename. Characters without
        a voice of their own are read in the Narrator’s voice.
      </p>
    </div>
  </div>
</template>
