// "Start from a preset…": the picker, the note under it, and what choosing one does.
//
// Two pages offer it — an endpoint's Connection tab and the scripting page's endpoint editor — and
// they differ only in where a preset's fields go: the Connection tab stages them in its draft, so
// Save applies them and Discard drops them, and the scripting editor binds every field straight
// onto the profile. Everything else is the same here: the options, grouped by provider; the note,
// which belongs to the endpoint it was chosen for and is forgotten when another is selected; and
// the copy, so a preset's billing or pricing object never becomes an endpoint's own — editing
// prices on one endpoint would otherwise change the preset and every endpoint made from it after.
import { useUiStore } from "@/stores/ui";

import { computed, ref, toValue, watch, type MaybeRefOrGetter, type WatchSource } from "vue";
import { presetsOf, type ScriptingPreset, type TtsPreset } from "@/lib/endpoints";
import { clone } from "@/lib/utils";
import type { EndpointKind } from "@/types";

export type AnyPreset = TtsPreset | ScriptingPreset;

export interface PresetPickerOptions {
  /** which kind's presets to offer; a getter where one tab serves both kinds */
  kind: MaybeRefOrGetter<EndpointKind>;
  /** the endpoint being edited: when it changes, the choice and its note are forgotten */
  endpoint: WatchSource<unknown>;
  /** puts a preset's fields where they belong. They are a copy, the caller's to keep. `false` when
   *  there is nothing to fill in, and nothing is said. */
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
