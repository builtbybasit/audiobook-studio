// A real scripting model writes cast facts and profiles, opt-in: `LIVE=1 bun test tests/live/castProfiles`.
// Bram is met as an old man whispering at a gate; later chapters say who he is and correct his age.
// Facts and profiles are printed to judge by eye.
import { describe, expect, test } from "bun:test";

import type { Book, CastFact, Character, ReasoningEffort } from "@/types";
import { newProfile } from "@/lib/scripting";
import { endpointScriptingProvider } from "~/providers/endpointScripting";
import { epubFile } from "../support/epub";
import { jsonBody, testApi, type TestApi } from "../support/server";

const env = process.env;

const CHAPTERS: { title: string; paragraphs: string[] }[] = [
  {
    title: "The Gate",
    paragraphs: [
      "Rain hammered the cobbles as Mara reached the north gate. An old man with grey hair sat hunched in the gatehouse, wrapped in a patched cloak.",
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
    reasoning: (env.SCRIPTING_PROVIDER_REASONING as ReasoningEffort | undefined) || null,
  });

  test(
    "facts land per chapter, the profile reads all three, and Refresh reads them again",
    async () => {
      const api = testApi({ scripting: endpointScriptingProvider() });
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
        jsonBody({ ids: [1, 2, 3], profile: "live" }),
      );
      await api.runner.idle();
      console.log(`scripted + profiles in ${Math.round(performance.now() - started) / 1000} s`);
      const { body: jobs } = await api.request<{ jobs: { kind: string; status: string }[] }>(
        "/api/jobs",
      );
      console.log(jobs.jobs.map((j) => `${j.kind}:${j.status}`).join(", "));
      const cast = await print(api, id, "after scripting");
      const bram = cast.find((c) => c.name === "Bram");
      expect(bram?.profile?.who).toBeTruthy();

      const again = performance.now();
      await api.request(`/api/books/${id}/characters/refresh`, jsonBody({ profile: "live" }));
      await api.runner.idle();
      console.log(`\nrefresh in ${Math.round(performance.now() - again) / 1000} s`);
      await print(api, id, "after Refresh");
    },
    { timeout: 1_800_000 },
  );
});
