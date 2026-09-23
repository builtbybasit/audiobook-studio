<script setup lang="ts">
// The API key field when a server answers: the server keeps the key, and this page only ever
// learns *that* it does (`hasKey`).
//
// So the field can never show the key back, and it does not pretend to: with a key held it says
// so and offers to replace or remove it. What is typed lives in this component and nowhere else —
// not the store, which the write-behind sends over and over, and not the page state that outlives
// the route — until Save sends it once (`saveKey`), after which it is dropped. Removing sends `""`,
// which is the server's word for "forget it"; every other write leaves the key alone.
import { ref, watch } from "vue";
import { Check as OkIcon, TriangleAlert as WarnIcon } from "@lucide/vue";
import { useEndpointsStore } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";
import type { EndpointKind } from "@/types";

const props = defineProps<{
  kind: EndpointKind;
  id: string;
  name: string;
  hasKey: boolean;
  needsKey: boolean;
}>();

const endpointsStore = useEndpointsStore();
const uiStore = useUiStore();
const typed = ref("");
/** replacing a held key: the input shows even though one is held */
const replacing = ref(false);
const confirmingRemove = ref(false);
const saving = ref(false);

// The same component is handed the next endpoint when the selection moves, and a key typed for one
// must never be saved against another.
watch(
  () => `${props.kind}:${props.id}`,
  () => reset(),
);

function reset() {
  typed.value = "";
  replacing.value = false;
  confirmingRemove.value = false;
}

async function send(value: string) {
  saving.value = true;
  try {
    const ok = await endpointsStore.saveKey(props.kind, props.id, value);
    if (!ok) return;
    reset();
    uiStore.toast(value ? `Key saved for ${props.name}` : `Key removed from ${props.name}`, {
      kind: "success",
      description: value
        ? "The server keeps it; this page never shows it again. The next request uses it."
        : "Requests that need a key fail until another one is saved.",
    });
  } finally {
    saving.value = false;
  }
}

function save() {
  const value = typed.value.trim();
  if (value) void send(value);
}

function remove() {
  if (!confirmingRemove.value) {
    confirmingRemove.value = true;
    return;
  }
  void send("");
}
</script>

<template>
  <div class="space-y-1 text-xs font-medium">
    <span :id="`${kind}-${id}-key-label`">API key</span>
    <div
      v-if="hasKey && !replacing"
      class="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 px-2 py-1.5 dark:border-zinc-700"
      role="status"
    >
      <OkIcon class="icon-sm text-emerald-600" />
      <span class="font-normal">Key saved on the server</span>
      <span class="ml-auto flex gap-2">
        <button class="btn-ghost btn-xs" type="button" :disabled="saving" @click="replacing = true">
          Replace
        </button>
        <button
          class="btn-ghost btn-xs text-red-600 dark:text-red-400"
          type="button"
          :disabled="saving"
          @click="remove"
          @blur="confirmingRemove = false"
        >
          {{ confirmingRemove ? "Yes, remove it" : "Remove" }}
        </button>
      </span>
    </div>
    <form v-else class="flex items-center gap-2" @submit.prevent="save">
      <input
        v-model="typed"
        type="password"
        autocomplete="off"
        class="input min-w-0 flex-1 font-mono"
        :aria-labelledby="`${kind}-${id}-key-label`"
        :placeholder="
          replacing ? 'Paste the new API key' : needsKey ? 'Paste the API key' : 'not required'
        "
      />
      <button class="btn-primary btn-xs shrink-0" type="submit" :disabled="saving || !typed.trim()">
        {{ saving ? "Saving…" : "Save key" }}
      </button>
      <button
        v-if="replacing"
        class="btn-ghost btn-xs shrink-0"
        type="button"
        :disabled="saving"
        @click="reset"
      >
        Cancel
      </button>
    </form>
    <p class="text-[11px] font-normal text-zinc-500">
      Sent to the server once and kept there, never in this browser. It is not in a settings export.
    </p>
    <p
      v-if="typed.trim() && !saving"
      class="rounded bg-violet-50 px-2 py-1 text-[11px] font-normal text-violet-700 dark:bg-violet-500/10 dark:text-violet-300"
    >
      Not saved yet — nothing uses this key until you press Save key.
    </p>
    <p
      v-else-if="needsKey && !hasKey"
      class="rounded bg-amber-400/10 px-2 py-1 text-[11px] font-normal text-amber-700 dark:text-amber-300"
    >
      <WarnIcon class="icon-sm" /> No key on the server — requests routed here fail with a “no API
      key” error until one is saved.
    </p>
  </div>
</template>
