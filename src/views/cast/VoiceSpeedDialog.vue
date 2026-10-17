<script setup lang="ts">
// Asks what to do with the lines made at a voice's old speed, in every book (`existingLines`
// store's `speedAsk`): redo them in all books, some, or none. Mounted once in App.
import { computed, ref, watch } from "vue";
import { DialogTitle } from "reka-ui";

import { plural } from "@/lib/contents";
import { money } from "@/lib/pricing/format";
import { useExistingLinesStore } from "@/stores/existingLines";
import { UiDialog, UiHint } from "@/ui";

const store = useExistingLinesStore();

const ask = computed(() => store.speedAsk);
const open = computed({
  get: () => !!store.speedAsk,
  set: (v) => {
    if (!v) store.speedAsk = null;
  },
});

type Book = NonNullable<typeof ask.value>["books"][number];

const option = ref<"all" | "pick" | "none">("none");
const picked = ref<string[]>([]);
watch(ask, () => {
  option.value = "none";
  picked.value = [];
});

const chosen = computed(() =>
  option.value === "all"
    ? (ask.value?.books.map((b) => b.bookId) ?? [])
    : option.value === "pick"
      ? picked.value
      : [],
);
const sumOf = (books: readonly Book[], of: (b: Book) => number) =>
  books.reduce((n, b) => n + of(b), 0);
const all = computed(() => ask.value?.books ?? []);
const redone = computed(() => all.value.filter((b) => chosen.value.includes(b.bookId)));
const total = (of: (b: Book) => number) => sumOf(all.value, of);
const lines = computed(() => total((b) => b.reNarrate + b.reApply));
const stretched = computed(() => total((b) => b.reApply));
const unavailable = computed(() => total((b) => b.unavailable));
// what the button would do, over the chosen books only
const narrate = computed(() => sumOf(redone.value, (b) => b.reNarrate));
const reapply = computed(() =>
  ask.value?.ready ? sumOf(redone.value, (b) => b.reApply - b.unavailable) : 0,
);
/** null when any chosen book's is unpriced */
const cost = computed(() =>
  redone.value.some((b) => b.reNarrate && b.cost == null)
    ? null
    : sumOf(redone.value, (b) => b.cost ?? 0),
);

const action = computed(() => {
  if (!chosen.value.length) return option.value === "pick" ? "Pick a book" : "Keep old speed";
  const parts = [];
  if (narrate.value)
    parts.push(
      `Re-narrate ${plural(narrate.value, "line")}` +
        (cost.value == null ? "" : ` · ~${money(cost.value)}`),
    );
  if (reapply.value) parts.push(`Re-apply ${plural(reapply.value, "line")}`);
  return parts.join(" · ") || "Nothing to redo";
});

const busy = ref(false);
async function act() {
  busy.value = true;
  await store.answerVoiceSpeed(chosen.value);
  busy.value = false;
}
</script>

<template>
  <UiDialog v-model:open="open" class="card w-[min(460px,94vw)] space-y-3 p-4">
    <template v-if="ask">
      <div>
        <DialogTitle class="font-semibold">{{ ask.title }}</DialogTitle>
        <p class="text-sm text-zinc-600 dark:text-zinc-300">
          {{ plural(lines, "line") }} in {{ plural(ask.books.length, "book") }}
          {{ lines === 1 ? "uses" : "use" }} the old speed.
        </p>
        <p v-if="narrate && stretched" class="text-xs text-zinc-500 dark:text-zinc-400">
          {{ plural(narrate, "line") }} to re-narrate, {{ plural(stretched, "line") }} to re-apply
          for free.
        </p>
      </div>

      <p
        v-if="stretched && !ask.ready"
        class="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
      >
        Voice effects can’t run on this machine
        <UiHint
          label="why effects can’t run"
          text="The server runs them with uv, and can’t find it. Install uv and restart the server to re-apply the lines made here; until then they keep the old speed."
        />
      </p>

      <div class="space-y-1.5 text-sm" role="radiogroup" aria-label="Which lines to redo">
        <label class="flex items-center gap-2">
          <input v-model="option" type="radio" value="all" class="accent-violet-600" />
          All books
        </label>
        <label class="flex items-center gap-2">
          <input v-model="option" type="radio" value="pick" class="accent-violet-600" />
          Pick books…
        </label>
        <div v-if="option === 'pick'" class="ml-6 max-h-48 space-y-1 overflow-y-auto">
          <label v-for="b in ask.books" :key="b.bookId" class="flex items-center gap-2 text-xs">
            <input v-model="picked" type="checkbox" :value="b.bookId" class="accent-violet-600" />
            <span class="truncate">{{ b.title }}</span>
            <span class="ml-auto shrink-0 text-zinc-400">{{
              plural(b.reNarrate + b.reApply, "line")
            }}</span>
          </label>
        </div>
        <label class="flex items-center gap-2">
          <input v-model="option" type="radio" value="none" class="accent-violet-600" />
          None: new lines only
          <UiHint
            label="leaving the lines as they are"
            text="Lines already made keep the old speed; lines made from now on get the new one."
          />
        </label>
      </div>

      <p v-if="unavailable" class="flex items-center gap-1 text-xs text-zinc-400">
        {{ plural(unavailable, "line") }} can’t be re-applied — re-narrate them
        <UiHint
          label="lines that can’t be re-applied"
          text="They were made before effects were kept apart from the voice. Re-narrate them to change their speed."
        />
      </p>

      <div class="flex justify-end gap-2">
        <button v-if="stretched" class="btn-ghost btn-xs" @click="open = false">Later</button>
        <button
          class="btn-primary btn-xs"
          :disabled="busy || (option !== 'none' && !narrate && !reapply)"
          @click="act"
        >
          {{ action }}
        </button>
      </div>
    </template>
  </UiDialog>
</template>
