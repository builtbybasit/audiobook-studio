// Voice samples waiting with a speaker: what an applied import keeps from a script file, and how
// they are served, discarded, restored and — a day after a discard — removed.
// See docs/script-transfer.md, slice 3.
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";

import type { Book, Character, ScriptFileSpeaker, SpeakerSamples } from "@/types";
import { renameCharacter } from "~/cast/ops";
import { upsertCharacter } from "~/db/cast";
import { speakerSamples } from "~/db/schema";
import { GRACE_MS } from "~/db/voiceSamples";
import { speakerSampleFiles } from "~/speakerSamples/files";
import { listSamples } from "~/speakerSamples/store";
import { epubFile } from "../support/epub";
import { testApi, type TestApi } from "../support/server";

// a WAV header is all a recording needs to be here: it is sniffed, never decoded
const wav = (tag: string) =>
  new Uint8Array([...`RIFF\0\0\0\0WAVEfmt ${tag}`].map((c) => c.charCodeAt(0)));
const CONSENT_AT = "2026-09-12T10:00:00.000Z";

const speaker = (name: string, folder?: string): ScriptFileSpeaker => ({
  name,
  aliases: [],
  gender: "f",
  description: "",
  style: "",
  voice: {
    endpoint: "Fish Audio",
    provider: "api.fish.audio",
    voiceId: name.toLowerCase(),
    voiceLabel: `${name} (clone)`,
  },
  ...(folder ? { samples: folder } : {}),
});

/** A script file whose cast is `cast`, carrying `recordings` for each speaker that names a folder. */
async function scriptFile(cast: ScriptFileSpeaker[], recordings: Record<string, Uint8Array[]>) {
  const zip = new JSZip();
  zip.file(
    "manifest.json",
    JSON.stringify({
      format: "audiobook-studio/script",
      version: 1,
      title: "Ledger",
      author: "",
      chapters: [],
    }),
  );
  zip.file("cast.json", JSON.stringify(cast));
  for (const s of cast) {
    if (!s.samples) continue;
    const files = recordings[s.name] ?? [];
    zip.file(
      `${s.samples}consent.json`,
      JSON.stringify({
        format: "audiobook-studio/voice-samples",
        version: 1,
        title: `${s.name} (clone)`,
        consentAt: CONSENT_AT,
        consentText: `${s.name} agreed.`,
        samples: files.map((_, i) => ({
          file: `sample-${i + 1}.wav`,
          name: `take-${i + 1}.wav`,
          format: "wav",
        })),
      }),
    );
    files.forEach((bytes, i) => zip.file(`${s.samples}sample-${i + 1}.wav`, bytes));
  }
  return new File([await zip.generateAsync({ type: "uint8array" })], "Ledger.script.zip", {
    type: "application/zip",
  });
}

let api: TestApi;
let id: string;

const character = (name: string): Character => ({
  name,
  aliases: [],
  gender: "f",
  description: "",
  voice: null,
  style: "",
  color: "#f472b6",
  major: false,
});

beforeEach(async () => {
  api = testApi();
  const { body } = await api.import<{ book: Book }>(
    await epubFile({ title: "Ledger", chapters: [{ title: "One", paragraphs: ["Rain fell."] }] }),
  );
  id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  for (const name of ["Vex", "Ines"]) upsertCharacter(api.db, id, character(name));
});

const store = async (file: File, speakers: unknown) => {
  const form = new FormData();
  form.set("file", file);
  form.set("speakers", typeof speakers === "string" ? speakers : JSON.stringify(speakers));
  return api.request<{ stored: SpeakerSamples[] }>(`/api/books/${id}/speaker-samples`, {
    method: "POST",
    body: form,
  });
};
const list = async () =>
  (await api.request<{ samples: SpeakerSamples[] }>(`/api/books/${id}/speaker-samples`)).body
    .samples;
const onDisk = (file: string) => join(api.audioDir, id, "samples", file);

/** Vex and Ines, each carrying recordings; the two share one, which is kept once. */
const both = () =>
  scriptFile([speaker("Vex", "voices/vex/"), speaker("Ines", "voices/ines/")], {
    Vex: [wav("shared"), wav("vex")],
    Ines: [wav("shared")],
  });

describe("keeping them", () => {
  test("keeps the recordings of the speakers named, and only theirs, with the file's consent", async () => {
    const res = await store(await both(), ["Vex"]);
    expect(res.status).toBe(201);
    const [vex] = res.body.stored;
    expect(vex).toMatchObject({
      speaker: "Vex",
      title: "Vex (clone)",
      consentAt: Date.parse(CONSENT_AT),
      consentText: "Vex agreed.",
      source: "Ledger.script.zip",
    });
    expect(vex.samples.map((s) => [s.name, s.format, s.bytes])).toEqual([
      ["take-1.wav", "wav", wav("shared").length],
      ["take-2.wav", "wav", wav("vex").length],
    ]);
    expect(await list()).toEqual([vex]);

    const served = await api.fetch(
      `/api/books/${id}/speaker-samples/${vex.id}/files/${vex.samples[1].file}`,
    );
    expect(served.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(wav("vex"));
  });

  test("storing again for a speaker replaces what was waiting", async () => {
    await store(await both(), ["Vex"]);
    const again = await store(
      await scriptFile([speaker("Vex", "voices/vex/")], { Vex: [wav("newer")] }),
      ["Vex"],
    );
    expect((await list()).map((s) => s.samples.length)).toEqual([1]);
    expect(await list()).toEqual(again.body.stored);
  });

  test.each<[string, unknown, RegExp]>([
    ["a speaker this book does not have", ["Tobin"], /no speaker by that name/],
    ["a speaker the file carries no recordings for", ["Ines"], /carries no recordings/],
    ["no speakers at all", [], /at least one speaker/],
    ["speakers that are not a JSON list", "Vex", /JSON array/],
  ])("%s is refused, and nothing is kept", async (_, speakers, message) => {
    const file = await scriptFile([speaker("Vex", "voices/vex/"), speaker("Ines")], {
      Vex: [wav("vex")],
    });
    const res = await store(file, speakers);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(message);
    expect(await list()).toEqual([]);
    expect(existsSync(join(api.audioDir, id, "samples"))).toBe(false);
  });

  test("a recording that is not audio refuses the request whole", async () => {
    const file = await scriptFile([speaker("Vex", "voices/vex/")], {
      Vex: [new TextEncoder().encode("not a recording")],
    });
    const res = await store(file, ["Vex"]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/not a WAV/);
  });
});

describe("where they belong", () => {
  test("a rename carries them; removing the book removes them, rows and files", async () => {
    const [vex] = (await store(await both(), ["Vex"])).body.stored;
    renameCharacter(api.db, id, "Vex", "Vesper");
    expect((await list()).map((s) => s.speaker)).toEqual(["Vesper"]);

    const file = onDisk(vex.samples[0].file);
    expect(existsSync(file)).toBe(true);
    expect((await api.request(`/api/books/${id}`, { method: "DELETE" })).status).toBeLessThan(300);
    expect(api.db.select().from(speakerSamples).all()).toEqual([]);
    for (let i = 0; i < 50 && existsSync(file); i++) await Bun.sleep(5);
    expect(existsSync(file)).toBe(false);
  });

  test.each([
    ["a name that climbs out", "..%2F..%2Fsecret.wav"],
    ["a name that is not a hash", "take-1.wav"],
    ["a hash no row of this set names", `${"0".repeat(32)}.wav`],
  ])("%s is not a recording", async (_, file) => {
    const [vex] = (await store(await both(), ["Vex"])).body.stored;
    const res = await api.request(`/api/books/${id}/speaker-samples/${vex.id}/files/${file}`);
    expect(res.status).toBe(404);
  });
});

describe("discarding them", () => {
  test("a discard hides them at once, and Undo brings them back", async () => {
    const [vex] = (await store(await both(), ["Vex"])).body.stored;
    const url = `/api/books/${id}/speaker-samples/${vex.id}`;
    expect((await api.request(url, { method: "DELETE" })).body).toEqual({ id: vex.id });
    expect(await list()).toEqual([]);
    expect((await api.request(`${url}/files/${vex.samples[0].file}`)).status).toBe(404);
    expect((await api.request(url, { method: "DELETE" })).status).toBe(404);

    const back = await api.request<{ sample: SpeakerSamples }>(`${url}/restore`, {
      method: "POST",
    });
    expect(back.body.sample).toEqual(vex);
    expect(await list()).toEqual([vex]);
  });

  test("a read a day after a discard removes it, and only the files nothing else names", async () => {
    const { stored } = (await store(await both(), ["Vex", "Ines"])).body;
    const vex = stored.find((s) => s.speaker === "Vex")!;
    const [shared, own] = vex.samples.map((s) => onDisk(s.file));
    await api.request(`/api/books/${id}/speaker-samples/${vex.id}`, { method: "DELETE" });

    const files = speakerSampleFiles(api.audioDir);
    // within the grace period nothing goes
    listSamples(api.db, files, id, { now: () => Date.now() + GRACE_MS - 60_000 });
    expect(api.db.select().from(speakerSamples).all()).toHaveLength(2);

    listSamples(api.db, files, id, { now: () => Date.now() + GRACE_MS + 60_000 });
    expect(
      api.db
        .select()
        .from(speakerSamples)
        .all()
        .map((r) => r.speaker),
    ).toEqual(["Ines"]);
    for (let i = 0; i < 50 && existsSync(own); i++) await Bun.sleep(5);
    expect(existsSync(own)).toBe(false);
    // Ines's recording is the same bytes, kept once, and still hers
    expect(existsSync(shared)).toBe(true);

    const restore = await api.request(`/api/books/${id}/speaker-samples/${vex.id}/restore`, {
      method: "POST",
    });
    expect(restore.status).toBe(404);
  });
});
