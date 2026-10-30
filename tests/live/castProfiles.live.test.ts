// A real scripting model writes cast facts and profiles, opt-in: `LIVE=1 bun test tests/live/castProfiles`.
// Bram is met as an old man whispering at a gate; later chapters say who he is and correct his age.
// Facts and profiles are printed to judge by eye.
import { describe, expect, test } from "bun:test";

import type { Book, CastFact, Character, Job, ReasoningEffort } from "@/types";
import { newProfile } from "@/lib/scripting";
import { readScript, replaceScript } from "~/db/script";
import { readFacts } from "~/db/facts";
import { plainText } from "~/epub/markdown";
import { getChapterBody } from "~/db/library";
import { endpointScriptingProvider } from "~/providers/endpointScripting";
import { epubFile } from "../support/epub";
import { jsonBody, testApi, type TestApi } from "../support/server";
import { liveScriptingConcurrency } from "../support/liveScripting";
import { sourceParagraphs } from "@/lib/sourceParagraphs";

const env = process.env;

const LASTING_LIMIT =
  "An oath bound Bram to speak the truth: he could never tell a lie, even to save himself.";

const CHAPTERS: { title: string; paragraphs: string[] }[] = [
  {
    title: "The Gate",
    paragraphs: [
      "Rain hammered the cobbles as Mara reached the north gate. Bram, the gatekeeper, looked like an old man with grey hair, hunched in the gatehouse and wrapped in a patched cloak.",
      "“Keep your voice down,” Bram whispered, pulling her into the shadow of the wall. “The watch is passing.”",
      "“I only want to get inside,” Mara said.",
      "“Everyone wants to get inside,” Bram said. “Wait until the bell.”",
    ],
  },
  {
    title: "The Barracks",
    paragraphs: [
      "In the morning Mara found the old barracks. A sergeant told her the gatekeeper had once been captain of the city guard, until the council dismissed him after the great fire.",
      "“He was the best captain this city had,” the sergeant said. “He still won’t take a coin he hasn’t earned.”",
      "That evening Bram poured her tea. “Your mother was my sister,” he said. “I should have told you at the gate.”",
      "“You’re my uncle?” Mara asked.",
    ],
  },
  {
    title: "The Tower",
    paragraphs: [
      "From the tower Mara looked down at the burnt quarter. Bram stood beside her, his voice rough and hoarse, as it had been ever since he breathed the smoke.",
      "“I was thirty when the tower burned,” Bram said. “My hair went grey that year. People take me for sixty. I’m barely past forty.”",
      "“Why stay at the gate?” Mara asked.",
      "“Because someone has to remember who lit that fire,” Bram said.",
    ],
  },
  {
    title: "The Oath",
    paragraphs: [
      LASTING_LIMIT,
      "Mara turned to Bram. “I grew up outside the city, with no school or tutor,” she explained. Bram looked puzzled. “That is why I needed help at the gate,” she continued.",
      "Mara turned pale when thunder struck, then regained her composure. Bram listened without speaking.",
    ],
  },
];

async function print(api: TestApi, id: string, heading: string): Promise<Character[]> {
  const { body } = await api.request<{ characters: Character[] }>(`/api/books/${id}/cast`);
  console.log(`\n===== ${heading} =====`);
  for (const c of body.characters.filter((c) => c.name !== "Narrator")) {
    const { body: f } = await api.request<{ facts: CastFact[] }>(
      `/api/books/${id}/characters/${encodeURIComponent(c.name)}/facts`,
    );
    console.log(
      `\n${c.name} · ${c.gender} · ${c.age ?? "age ?"} · ${JSON.stringify(c.voiceType ?? {})}`,
    );
    for (const fact of f.facts) console.log(`  [${fact.kind}] ${fact.text}`);
    if (c.profile)
      console.log(
        `  WHO: ${c.profile.who}\n  PERSONALITY: ${c.profile.personality}\n  VOICE: ${c.profile.voice}`,
      );
  }
  return body.characters;
}

describe.skipIf(!env.LIVE || !env.SCRIPTING_PROVIDER_URL)("a real model's cast facts", () => {
  const profile = newProfile({
    id: "live",
    name: "Live scripting model",
    baseUrl: (env.SCRIPTING_PROVIDER_URL ?? "").replace(/\/+$/, ""),
    model: env.SCRIPTING_PROVIDER_MODEL ?? "",
    needsKey: false,
    timeoutSec: 600,
    maxOutputTokens: 0,
    concurrency: env.LIVE ? liveScriptingConcurrency(env) : 4,
    reasoning: (env.SCRIPTING_PROVIDER_REASONING as ReasoningEffort | undefined) || null,
  });

  test(
    "facts retain defining traits and Refresh uses prose despite incorrect script attribution",
    async () => {
      const real = endpointScriptingProvider();
      let active = 0;
      let peak = 0;
      const api = testApi({
        scripting: {
          ...real,
          async ask(input) {
            active++;
            peak = Math.max(peak, active);
            try {
              return await real.ask!(input);
            } finally {
              active--;
            }
          },
        },
      });
      console.log(`Scripting concurrency: ${profile.concurrency}`);
      const saved = await api.request("/api/endpoints", {
        ...jsonBody({ endpoints: [], profiles: [profile], credentials: [] }),
        method: "PUT",
      });
      expect(saved.status).toBe(200);
      const { status, body } = await api.import<{ book: Book }>(
        await epubFile({ title: "The North Gate", chapters: CHAPTERS }),
      );
      expect(status).toBe(201);
      const id = body.book.id;
      await api.request(`/api/books/${id}/confirm`, { method: "POST" });

      const started = performance.now();
      await api.request(
        `/api/books/${id}/chapters/script`,
        jsonBody({ ids: [1, 2, 3, 4], profile: "live" }),
      );
      await api.runner.idle();
      console.log(`scripted + profiles in ${Math.round(performance.now() - started) / 1000} s`);
      const { body: jobs } = await api.request<{ jobs: Job[] }>("/api/jobs");
      console.log(jobs.jobs.map((j) => `${j.kind}:${j.status}`).join(", "));
      console.log("Failed jobs:", JSON.stringify(jobs.jobs.filter((j) => j.status === "failed")));
      const cast = await print(api, id, "after scripting");
      const bram = cast.find((c) => c.name === "Bram");
      expect(bram?.profile?.who).toBeTruthy();

      // Deliberately corrupt attribution without changing the source. Refresh must not inherit it.
      api.db.transaction((tx) =>
        replaceScript(
          tx,
          id,
          4,
          readScript(tx, id, 4).map((s) => ({
            ...s,
            speaker: s.type === "dialogue" ? "Bram" : s.speaker,
          })),
        ),
      );
      const again = performance.now();
      await api.request(`/api/books/${id}/characters/refresh`, jsonBody({ profile: "live" }));
      await api.runner.idle();
      console.log(`\nrefresh in ${Math.round(performance.now() - again) / 1000} s`);
      const refreshed = await print(api, id, "after Refresh");
      const { body: settled } = await api.request<{ jobs: Job[] }>("/api/jobs");
      console.log(
        "Failed jobs after refresh:",
        JSON.stringify(settled.jobs.filter((j) => j.status === "failed")),
      );
      const finalBram = refreshed.find((c) => c.name === "Bram")!;
      const finalMara = refreshed.find((c) => c.name === "Mara")!;
      expect(finalBram.profile?.who).toMatch(/captain/i);
      expect(finalBram.age).toBe("middle-aged");
      expect(JSON.stringify(finalBram.profile)).toMatch(
        /truth|(?:cannot|never|unable|forbid|prevent|incapable).*li(?:e|es|ing)/i,
      );
      expect(JSON.stringify(finalBram.profile)).not.toMatch(/grew up outside|no school|no.*tutor/i);
      expect(finalMara.profile?.personality ?? "").not.toMatch(/pale|thunder/i);
      expect(readFacts(api.db, id, "Bram").some((f) => f.chapterId === 4)).toBe(true);
      for (const c of [finalBram, finalMara])
        for (const f of readFacts(api.db, id, c.name)) {
          expect(f.evidence).toBeTruthy();
          const paragraphs = sourceParagraphs(plainText(getChapterBody(api.db, id, f.chapterId)!));
          expect(f.sourceIds?.length).toBeGreaterThan(0);
          expect(f.evidence).toBe(
            f.sourceIds!.map((id) => paragraphs.find((p) => p.id === id)?.text).join("\n\n"),
          );
        }
      const oathParagraph = sourceParagraphs(plainText(getChapterBody(api.db, id, 4)!)).find((p) =>
        p.text.includes(LASTING_LIMIT),
      )!;
      const oath = readFacts(api.db, id, "Bram").find(
        (f) => f.chapterId === 4 && /oath|lie|truth/i.test(f.text),
      );
      expect(oath?.sourceIds).toContain(oathParagraph.id);
      expect(settled.jobs.every((j) => j.status === "done")).toBe(true);
      expect(peak).toBeLessThanOrEqual(profile.concurrency);
      console.log(`Peak concurrent cast requests: ${peak}`);
    },
    { timeout: 1_800_000 },
  );
});
