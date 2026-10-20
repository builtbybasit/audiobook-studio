// The Connection tab's local server fields: typed text becomes `launch` on Save, for every kind.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { unifyEndpoint, unifyProfile, unifyTranscriber } from "@/lib/endpoints";
import { useEndpointsStore } from "@/stores/endpoints";
import type { LocalServer } from "@/types";
import {
  applyDraft,
  draftChanges,
  draftFor,
  gb,
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
  stopCommand: "",
  heavy: false,
  readySec: null,
  ...d,
});

describe("the local server draft", () => {
  test.each<[string, Partial<LaunchDraft>, LocalServer | null]>([
    ["every text empty is none", { dir: "  ", stopCommand: " ", heavy: true, readySec: 60 }, null],
    [
      "texts trimmed, no ready time or stop command left out",
      { dir: " /srv/tts ", command: " ./run.sh ", stopCommand: "  ", heavy: true },
      { dir: "/srv/tts", command: "./run.sh", heavy: true },
    ],
    [
      "a stop command kept, trimmed",
      { command: "docker run phonon", stopCommand: " docker stop phonon " },
      { dir: "", command: "docker run phonon", stopCommand: "docker stop phonon", heavy: false },
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
    ["a dot-relative Windows folder", { dir: ".\\srv", command: "go" }, true],
    ["no folder (the home folder)", { command: "go" }, false],
    ["a POSIX folder", { dir: "/srv", command: "go" }, false],
    ["a Windows folder", { dir: "C:\\servers\\breeze", command: "go" }, false],
    ["a Windows folder with slashes", { dir: "C:/servers", command: "go" }, false],
    ["a UNC folder", { dir: "\\\\host\\share", command: "go" }, false],
    ["a folder with no command", { dir: "/srv" }, true],
    ["a stop command with no start command", { stopCommand: "docker stop phonon" }, true],
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
      draftFor(u).launch.stopCommand = "docker stop tts";
      expect(draftChanges(u)).toContain("launch");

      draftFor(u).launch = typed({ heavy: true });
      applyDraft(u);
      expect("launch" in u.entry).toBe(false);
      expect(draftChanges(u)).toEqual([]);
    },
  );
});

test.each([
  [8192, "8.0"],
  [5734, "5.6"],
])("%p MiB of VRAM reads %p GB", (mb, shown) => {
  expect(gb(mb)).toBe(shown);
});
