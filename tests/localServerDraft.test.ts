// The Connection tab's local server fields: typed text becomes `launch` on Save, for every kind.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { unifyEndpoint, unifyProfile, unifyTranscriber } from "@/lib/endpoints";
import { useEndpointsStore } from "@/stores/endpoints";
import type { LocalServer } from "@/types";
import {
  applyDraft,
  draftChanges,
  draftFor,
  launchOf,
  launchProblem,
  type LaunchDraft,
} from "@/views/endpoints/state";
import { testPinia, type TestPinia } from "./support/pinia";

let pinia: TestPinia;
beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  pinia = testPinia();
});
afterEach(() => pinia.stop());

const typed = (d: Partial<LaunchDraft>): LaunchDraft => ({
  dir: "",
  command: "",
  heavy: false,
  readySec: null,
  ...d,
});

describe("the local server draft", () => {
  test.each<[string, Partial<LaunchDraft>, LocalServer | null]>([
    ["both texts empty is none", { dir: "  ", heavy: true, readySec: 60 }, null],
    [
      "texts trimmed, no ready time left out",
      { dir: " /srv/tts ", command: " ./run.sh ", heavy: true },
      { dir: "/srv/tts", command: "./run.sh", heavy: true },
    ],
    [
      "ready time a whole second",
      { dir: "/srv", command: "go", readySec: 12.6 },
      { dir: "/srv", command: "go", heavy: false, readySec: 13 },
    ],
  ])("%s", (_, d, launch) => {
    expect(launchOf(typed(d))).toEqual(launch);
  });

  test.each<[string, Partial<LaunchDraft>, boolean]>([
    ["nothing typed", {}, false],
    ["a relative folder", { dir: "srv", command: "go" }, true],
    ["a command with no folder", { command: "go" }, true],
    ["a folder with no command", { dir: "/srv" }, true],
    ["an absolute folder and a command", { dir: "/srv", command: "go" }, false],
  ])("%s: refused %p", (_, d, refused) => {
    expect(launchProblem(typed(d)) !== null).toBe(refused);
  });

  test.each(["tts", "scripting", "transcription"] as const)(
    "a %s endpoint takes it on Save and drops it when both texts are cleared",
    (kind) => {
      const store = useEndpointsStore();
      const add = {
        tts: () => unifyEndpoint(store.addEndpoint()),
        scripting: () => {
          const id = store.addScriptProfile();
          return unifyProfile(store.profiles.find((p) => p.id === id)!);
        },
        transcription: () => unifyTranscriber(store.addTranscriber()),
      };
      const u = add[kind]();
      draftFor(u).launch = typed({ dir: "/srv", command: "go", heavy: true });
      expect(draftChanges(u)).toContain("launch");
      applyDraft(u);
      expect(u.entry.launch).toEqual({ dir: "/srv", command: "go", heavy: true });
      expect(draftChanges(u)).not.toContain("launch");

      draftFor(u).launch = typed({ heavy: true });
      applyDraft(u);
      expect("launch" in u.entry).toBe(false);
      expect(draftChanges(u)).toEqual([]);
    },
  );
});
