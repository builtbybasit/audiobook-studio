<script setup lang="ts">
// The reader's right rail: the cast *in this chapter*, with aliases, spoiler-hidden descriptions,
// the voice each is read in and an inline rename; the rest of the cast collapsed under it with
// their lines across the book. A name filters the reader to that speaker's lines.
import { computed, ref } from "vue";
import { plural } from "@/lib/contents";
import { GENDER } from "@/lib/scriptReview";
import { useCastStore } from "@/stores/cast";
import { useReader } from "@/stores/reader";
import { useScriptsStore } from "@/stores/scripts";
import ReadFailure, { scriptsUnread } from "@/components/ReadFailure.vue";
import SpoilerText from "@/components/SpoilerText.vue";
import VoicePicker from "@/components/VoicePicker.vue";
import { PanelRightClose as HideCastIcon } from "@lucide/vue";
import { useScript } from "@/views/scripting/shared";
import type { Character } from "@/types";

const props = defineProps<{
  bookId: string;
  chapterId: number;
  /** whether every scripted chapter's script has been read, so a line count across the book is one */
  bookCounted: boolean;
  /** how many of those scripts could not be read */
  bookUnread: number;
}>();
/** read the scripts that could not be, again */
defineEmits<{ retry: [] }>();
/** the speaker the reader is filtered to; "" for everyone */
const speaker = defineModel<string>("speaker", { required: true });
const castStore = useCastStore();
const scriptsStore = useScriptsStore();
const reader = useReader();
const { cast, counts, inChapter } = useScript(props);
const rest = computed(() => cast.value.filter((c) => !counts.value[c.name]));
const showRest = ref(false);

const editingName = ref<string | null>(null);
const draft = ref("");
function startRename(c: Character) {
  editingName.value = c.name;
  draft.value = c.name;
}
function commitRename() {
  if (editingName.value) castStore.renameCharacter(props.bookId, editingName.value, draft.value);
  editingName.value = null;
}
</script>

<template>
  <div class="card max-h-[50vh] min-h-0 overflow-y-auto overflow-x-hidden p-3 lg:max-h-none">
    <div class="mb-2 flex items-center gap-2">
      <span class="label">In this chapter · {{ inChapter.length }} speakers</span>
      <button
        class="icon-btn ml-auto"
        title="hide the cast (c)"
        aria-label="Hide the cast"
        @click="reader.showCast = false"
      >
        <HideCastIcon class="icon-sm" />
      </button>
    </div>
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
          @click="speaker = speaker === c.name ? '' : c.name"
          @dblclick="startRename(c)"
        >
          {{ c.name }}
        </button>
        <span class="text-[11px] text-zinc-400">{{ GENDER[c.gender] ?? "unknown" }}</span>
      </div>
      <div class="mt-1 flex flex-wrap items-center gap-1 pl-4 text-[11px] text-zinc-500">
        <span>{{ plural(counts[c.name], "line") }}</span>
        <template v-if="c.aliases.length"
          ><span>· a.k.a.</span
          ><span
            v-for="a in c.aliases"
            :key="a"
            class="rounded bg-zinc-100 px-1 dark:bg-zinc-800"
            >{{ a }}</span
          ></template
        >
        <RouterLink
          v-if="c.isNew"
          :to="`/book/${bookId}/cast`"
          class="rounded bg-amber-400/20 px-1 font-semibold text-amber-600 hover:underline"
          title="review this name on the Cast page — rename it, or merge it into the speaker it belongs to"
          >new · alias?</RouterLink
        >
      </div>
      <div class="mt-2 pl-4 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
        <SpoilerText :text="c.description" :hidden="c.name !== 'Narrator'" />
      </div>
      <div class="mt-2 flex items-center gap-1 pl-4 text-[11px]">
        <VoicePicker
          :model-value="c.voice"
          @update:model-value="(v) => castStore.setVoice(bookId, c.name, v)"
          :book-id="bookId"
          :speaker="c.name"
          size="xs"
          class="min-w-0 flex-1"
          block
        />
        <button
          class="shrink-0 rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          @click="startRename(c)"
        >
          rename
        </button>
      </div>
    </div>

    <button
      class="mt-1 w-full rounded-lg border border-dashed border-zinc-300 py-2 text-xs text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
      @click="showRest = !showRest"
    >
      {{ showRest ? "Hide" : "Show" }} the rest of the cast ({{ rest.length }})
    </button>
    <div v-if="showRest" class="mt-2 space-y-0.5">
      <ReadFailure
        v-if="bookUnread"
        class="px-2"
        :message="`${scriptsUnread(bookUnread)}, so these speakers’ lines are not counted.`"
        @retry="$emit('retry')"
      />
      <div
        v-for="c in rest"
        :key="c.name"
        class="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <span class="h-2 w-2 rounded-full" :style="{ background: c.color }"></span>
        <span class="min-w-0 flex-1 truncate">{{ c.name }}</span>
        <span class="font-mono text-zinc-400">{{
          bookCounted ? (scriptsStore.lineCounts(bookId)[c.name] ?? 0) : "…"
        }}</span>
      </div>
    </div>
    <p class="mt-3 text-[11px] leading-relaxed text-zinc-400">
      Click a name to filter the reader to their lines, double-click to rename, and set the voice it
      is read in right here. A speaker with no voice of their own borrows the Narrator’s.
    </p>
  </div>
</template>
