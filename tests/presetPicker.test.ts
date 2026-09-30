// "Start from a preset…", as both pages that offer it use it: an endpoint's Connection tab, which
// stages what a preset fills in and applies it on Save, and the scripting page's endpoint editor,
// which writes it straight onto the profile it binds its fields to.
//
// What these guard is what the page says. The Connection tab promises that nothing is dispatched
// until Save, so a preset's prices must not reach the endpoint — and the write-behind that sends it
// to the server — before then, and Discard must put them back. Either way the fields handed over
// are a copy: a preset's pricing object that became a profile's own would be edited by the Pricing
// tab, and every profile made from that preset afterwards would start from the edited rates.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { nextTick, ref } from "vue";

import { usePresetPicker, type AnyPreset } from "@/composables/usePresetPicker";
import { SCRIPTING_PRESETS, TTS_PRESETS, scriptingPresetById, unifyProfile } from "@/lib/endpoints";
import { clone } from "@/lib/utils";
import { useEndpointsStore } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";
import type { EndpointKind } from "@/types";
import {
  applyDraft,
  discardDraft,
  draftChanges,
  draftDirty,
  stagePreset,
} from "@/views/endpoints/state";
import { testPinia, type TestPinia } from "./support/pinia";

let pinia: TestPinia;
let toasts: { msg: string; description: string }[];

beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  pinia = testPinia();
  toasts = [];
  const uiStore = useUiStore();
  uiStore.toast = ((msg: string, opts: { description?: string } = {}) => {
    toasts.push({ msg, description: opts.description ?? "" });
    return "test";
  }) as typeof uiStore.toast;
});
afterEach(() => pinia.stop());

/** A picker whose `fill` keeps what it was handed, for the endpoint `endpoint` names. */
function picker(kind: EndpointKind = "scripting") {
  const endpoint = ref("a");
  const filled: { fields: AnyPreset["apply"]; preset: AnyPreset }[] = [];
  const it = pinia.run(() =>
    usePresetPicker({
      kind,
      endpoint,
      fill: (fields, preset) => void filled.push({ fields, preset }),
      next: "Check it.",
    }),
  );
  return { ...it, endpoint, filled };
}

describe("the preset picker", () => {
  test("offers the kind's presets under their providers, after one that leaves everything alone", () => {
    const { options } = picker("tts");
    expect(options.value[0]).toMatchObject({ value: "", label: "Start from a preset…" });
    expect(options.value.slice(1).map((o) => o.value)).toEqual(TTS_PRESETS.map((p) => p.id));
    expect(options.value.slice(1).every((o) => "group" in o && o.group)).toBe(true);
  });

  test("hands over a copy of the preset's fields, shows its note, and says what to do next", () => {
    const { choose, filled, note, presetId } = picker();
    const before = clone(scriptingPresetById("deepseek-flash")!.apply);
    choose("deepseek-flash");
    expect(presetId.value).toBe("deepseek-flash");
    expect(note.value).toBe(scriptingPresetById("deepseek-flash")!.note);
    expect(filled).toHaveLength(1);
    expect(filled[0].fields).toEqual(before);
    // editing what was handed over leaves the preset as published
    filled[0].fields.pricing!.windows[0].rates!.output = 99;
    expect(scriptingPresetById("deepseek-flash")!.apply).toEqual(before);
    expect(toasts).toEqual([
      { msg: "DeepSeek · V4.1 Flash defaults filled in", description: "Check it." },
    ]);
  });

  test("forgets the choice and its note when another endpoint is selected", async () => {
    const { choose, endpoint, note, presetId } = picker();
    choose(SCRIPTING_PRESETS[0].id);
    expect(note.value).toBeTruthy();
    endpoint.value = "b";
    await nextTick();
    expect(presetId.value).toBe("");
    expect(note.value).toBeUndefined();
  });

  test("choosing the blank option, or an id it does not know, fills in nothing", () => {
    const { choose, filled, presetId } = picker();
    choose("");
    choose("fish-pro");
    expect(presetId.value).toBe("");
    expect(filled).toEqual([]);
    expect(toasts).toEqual([]);
  });

  test("says nothing when there was nowhere to fill it in", () => {
    const it = pinia.run(() =>
      usePresetPicker({ kind: "scripting", endpoint: ref(""), fill: () => false, next: "" }),
    );
    it.choose("openai-luna");
    expect(toasts).toEqual([]);
  });
});

describe("a preset on the Connection tab", () => {
  /** A scripting endpoint as the Endpoints page holds it, and a picker wired as that tab wires it. */
  function connection() {
    const store = useEndpointsStore();
    const id = store.addScriptProfile();
    const profile = store.profiles.find((p) => p.id === id)!;
    const u = unifyProfile(profile);
    const it = pinia.run(() =>
      usePresetPicker({
        kind: () => u.kind,
        endpoint: () => u.key,
        fill: (fields, preset) => stagePreset(u, preset.label, fields),
        next: "",
      }),
    );
    return { profile, u, ...it };
  }

  test("changes nothing on the endpoint until Save, and lists its prices among the changes", () => {
    const { profile, u, choose } = connection();
    const before = clone(profile);
    choose("xai-grok-4.7");
    expect(profile).toEqual(before);
    expect(draftChanges(u)).toContain("preset");
    expect(draftChanges(u)).toContain("baseUrl");
  });

  test("is dropped whole by Discard: prices, limits and connection alike", () => {
    const { profile, u, choose } = connection();
    const before = clone(profile);
    choose("xai-grok-4.7");
    discardDraft(u);
    expect(draftDirty(u)).toBe(false);
    expect(profile).toEqual(before);
  });

  test("is applied whole by Save, as a copy the preset does not share", () => {
    const { profile, u, choose } = connection();
    choose("gemini-flash");
    applyDraft(u);
    const { apply } = scriptingPresetById("gemini-flash")!;
    expect(clone(profile)).toMatchObject({
      name: apply.name,
      baseUrl: apply.baseUrl,
      model: apply.model,
      inPrice: apply.inPrice,
      outPrice: apply.outPrice,
      pricing: apply.pricing,
    });
    expect(profile.pricing).not.toBe(apply.pricing);
    expect(draftDirty(unifyProfile(profile))).toBe(false);
  });
});

describe("a preset in the scripting page's endpoint editor", () => {
  test("is written straight onto the selected profile, as a copy", () => {
    const store = useEndpointsStore();
    const selected = ref(store.addScriptProfile());
    const profile = () => store.profiles.find((p) => p.id === selected.value);
    // wired as ScriptEndpoints wires it
    const { choose } = pinia.run(() =>
      usePresetPicker({
        kind: "scripting",
        endpoint: selected,
        fill: (fields) => (profile() ? void Object.assign(profile()!, fields) : false),
        next: "",
      }),
    );
    choose("deepseek-flash");
    const { apply } = scriptingPresetById("deepseek-flash")!;
    expect(profile()).toMatchObject({ model: apply.model, inPrice: 0.15, outPrice: 0.6 });
    profile()!.pricing!.windows[0].rates!.input = 7;
    expect(apply.pricing!.windows[0].rates!.input).toBe(0.3);
  });
});
