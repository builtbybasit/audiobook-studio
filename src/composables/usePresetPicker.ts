// "Start from a preset…": the picker, its note, and what choosing one does. The Connection tab
// stages a preset's fields in its draft and the scripting editor binds them to the profile; only
// `fill` differs. Fields are copied, so editing one endpoint's prices never changes the preset.
import { useUiStore } from "@/stores/ui";

import { computed, ref, toValue, watch, type MaybeRefOrGetter, type WatchSource } from "vue";
import { presetsOf, type AnyPreset } from "@/lib/endpoints";
import { clone } from "@/lib/utils";
import type { EndpointKind } from "@/types";

export type { AnyPreset };

export interface PresetPickerOptions {
  /** which kind's presets to offer; a getter where one tab serves every kind */
  kind: MaybeRefOrGetter<EndpointKind>;
  /** the endpoint being edited: when it changes, the choice and its note are forgotten */
  endpoint: WatchSource<unknown>;
  /** Puts a preset's fields (a copy, the caller's to keep) where they belong. `false` when there
   *  is nothing to fill in, and nothing is said. */
  fill: (fields: AnyPreset["apply"], preset: AnyPreset) => void | false;
  /** the toast's second line: what to check, and when it takes effect */
  next: string;
}

export function usePresetPicker(opts: PresetPickerOptions) {
  const uiStore = useUiStore();
  const presets = computed<AnyPreset[]>(() => presetsOf(toValue(opts.kind)));
  const options = computed(() => [
    { value: "", label: "Start from a preset…", hint: "leaves every field as it is" },
    ...presets.value.map((p) => ({ value: p.id, label: p.label, hint: p.hint, group: p.group })),
  ]);
  const presetId = ref("");
  const find = (id: string) => presets.value.find((p) => p.id === id);
  /** the caveat that belongs with the preset just chosen */
  const note = computed(() => (presetId.value ? find(presetId.value)?.note : undefined));
  watch(opts.endpoint, () => (presetId.value = ""));

  function choose(id: string | number | null): void {
    const preset = find(String(id ?? ""));
    presetId.value = preset?.id ?? "";
    if (!preset) return;
    if (opts.fill(clone(preset.apply), preset) === false) return;
    uiStore.toast(`${preset.label} defaults filled in`, {
      kind: "success",
      description: opts.next,
    });
  }

  return { options, presetId, note, choose };
}
