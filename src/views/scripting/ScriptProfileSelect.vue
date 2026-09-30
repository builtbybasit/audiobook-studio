<script setup lang="ts">
// Which scripting endpoint runs go to: the one picker every part of the Scripting page uses, so
// they all list the same endpoints the same way. Every profile is listed, a paused one or one whose
// settings need checking said as such beside its name, since picking it is allowed and the run's
// blockers then say what stands in the way. What it shows is the profile a run would actually go
// to (`runProfile`) — never an id that names nothing.
import { computed } from "vue";
import { keyInPlace } from "@/services/endpointSettings";
import { profileErrors } from "@/lib/scripting";
import { useEndpointsStore } from "@/stores/endpoints";
import { useScriptingStore } from "@/stores/scripting";
import { UiSelect } from "@/ui";
import type { Profile } from "@/types";

withDefaults(defineProps<{ size?: "xs" | "sm"; block?: boolean }>(), {
  size: "xs",
  block: true,
});
const endpointsStore = useEndpointsStore();
const scriptingStore = useScriptingStore();

/** What stands out about a profile in the list: why it cannot run, or else its model. */
function state(p: Profile): string {
  if (!p.enabled) return "Paused";
  if (profileErrors(p).length) return "Check settings";
  if (p.needsKey && !keyInPlace(p)) return "Key needed";
  return p.model;
}
const options = computed(() =>
  endpointsStore.profiles.map((p) => ({
    value: p.id,
    label: p.name || "Untitled endpoint",
    hint: state(p),
  })),
);
</script>

<template>
  <UiSelect
    :model-value="scriptingStore.runProfile?.id ?? null"
    :options="options"
    :placeholder="options.length ? 'Choose an endpoint' : 'No scripting endpoints yet'"
    :disabled="!options.length"
    :size="size"
    :block="block"
    aria-label="Scripting endpoint"
    @update:model-value="
      (v) => (scriptingStore.scriptSettings.profile = v == null ? null : String(v))
    "
  />
</template>
