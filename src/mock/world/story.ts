// The situations the seeded books are in. `seedPipeline` gives every book a clean "scripted up to
// here, narrated up to here" shape; this is where each one is nudged into the state a screen needs
// to be worth looking at — a failed chapter, an unverified chunk, an alias the model invented, a
// take waiting to be compared, a long serial mid-flight.
//
// Everything here mutates the draft it is handed and nothing here is shared, so a fresh world is a
// fresh set of situations.
import { silenceOf, DEFAULT_PACING } from "@/lib/speech";
import { PALETTE } from "@/mock/fixtures/style";
import { noteOf } from "@/mock/fixtures/notices";
import { routeOf, seedAudit, timeOf } from "@/mock/world/audio";
import type { WorldDraft } from "@/mock/world/draft";
import type { SegmentAudio } from "@/types";

export function seedStory(w: WorldDraft): void {
  w.chapters.drowned[1].scripting = "failed";
  delete w.segments["drowned:2"];
  w.chapters.cliche[3].narration = "failed";
  // ch 7 of Cliché: one chunk failed verification and was kept whole as narration
  w.chapters.cliche[6].scripting = "fallback";
  {
    const segs = w.segments["cliche:7"];
    const run = segs.slice(9, 15);
    segs.splice(9, 6, {
      id: 0,
      type: "narration",
      speaker: "Narrator",
      text: run.map((x) => (x.type === "dialogue" ? `“${x.text}”` : x.text)).join(" "),
      direction: "",
      fallback: true,
      fallbackCount: 6,
      fallbackMismatch: run[2].text.slice(0, 40),
      audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
    });
    segs.forEach((x, i) => (x.id = i + 1));
  }
  // ch 12 of Cliché: the LLM emitted the alias "Ning" as its own speaker → merge suggestion on the Cast page
  {
    let n = 0;
    for (const seg of w.segments["cliche:12"])
      if (seg.speaker === "Ji Ning" && n < 3) {
        seg.speaker = "Ning";
        n++;
      }
  }
  w.characters.cliche.push({
    name: "Ning",
    aliases: [],
    gender: "?",
    description: "",
    voice: null,
    style: "",
    color: PALETTE[7],
    major: false,
    isNew: true,
  });
  // ch 2 of Cliché: two w.segments edited after narration → stale
  w.chapters.cliche[1].narration = "stale";
  w.segments["cliche:2"][3].audio.status = "stale";
  w.segments["cliche:2"][8].audio.status = "stale";
  w.segments["cliche:4"].forEach((s, i) => {
    const ep = routeOf(w, "cliche", s.speaker);
    s.audio = {
      status: i % 9 === 4 ? "failed" : "done",
      endpoint: ep.id,
      ms: 800 + i * 20,
      duration: i % 9 === 4 ? 0 : s.text.split(" ").length / 2.6,
      ...seedAudit(w, "cliche", s, ep, i),
      error:
        i % 9 === 4
          ? {
              code: 500,
              message: "server error",
              body: '{"error":{"message":"The server had an error while processing your request.","type":"server_error"}}',
            }
          : undefined,
    };
  });
  // ch 1 of Starforge: a listened-to chapter. Two lines are flagged as bad audio and one of them has
  // already been retaken, so the ledger opens on a take waiting to be compared.
  {
    const segs = w.segments["starforge:1"];
    const spoken = segs.filter((x) => x.type !== "narration");
    const bad = spoken[1] ?? segs[1];
    const slow = spoken[3] ?? segs[3];
    bad.flag = {
      kind: "pronunciation",
      note: `“${bad.text.split(" ").slice(0, 2).join(" ")}” is read as two words`,
      at: Date.now() - 26 * 60000,
    };
    slow.flag = {
      kind: "pause",
      note: "half a second of silence mid-sentence",
      at: Date.now() - 22 * 60000,
    };
    const retaken = spoken[0] ?? segs[0];
    retaken.flag = {
      kind: "delivery",
      note: "flat — the line is meant to land as a threat",
      at: Date.now() - 31 * 60000,
    };
    // take 2 is rendered and waiting: the ledger opens on a comparison, and until it is accepted the
    // chapter still plays, times and exports take 1
    const first = { ...(retaken.audio as SegmentAudio) };
    retaken.direction = "cold, deliberate";
    // the direction was changed on the line before the retake was asked for, so take 1 is out of date
    retaken.audio = { ...first, status: "stale", n: 1 };
    retaken.candidate = {
      ...first,
      n: 2,
      ms: Math.round(first.ms * 1.1),
      duration: first.duration * 1.18,
      direction: retaken.direction,
      at: Date.now() - 19 * 60000,
    };
    w.chapters.starforge[0].narration = "stale";
    // pacing set by ear while listening: a beat after the threat lands, none before the answer
    retaken.pause = 1.5;
    if (spoken[1]) spoken[1].pause = 0;
    w.chapters.starforge[0].duration = timeOf(segs);
  }

  // Thousand Gates: a long serial mid-flight. Most of it is narrated and current; a handful of
  // w.chapters are stale, one failed outright, one is only half rendered, and the tail has no audio
  // yet — the mix a build has to explain rather than quietly work around.
  {
    const chs = w.chapters.gates;
    const stale = [37, 88, 140, 152, 191];
    for (const id of stale) {
      const c = chs[id - 1];
      c.narration = "stale";
      const segs = w.segments[`gates:${id}`];
      segs[2].audio.status = "stale";
      segs[Math.min(9, segs.length - 1)].audio.status = "stale";
    }
    // narration failed outright: nothing was kept
    {
      const c = chs[95];
      c.narration = "failed";
      c.duration = 0;
      for (const s of w.segments["gates:96"])
        s.audio = { status: "failed", endpoint: null, ms: 0, duration: 0 };
    }
    // and one where most lines landed but a few did not — a build here would leave holes
    {
      const c = chs[140];
      c.narration = "failed";
      const segs = w.segments["gates:141"];
      segs.forEach((s, i) => {
        if (i % 7 === 3)
          s.audio = {
            status: "failed",
            endpoint: s.audio.endpoint,
            ms: 0,
            duration: 0,
            error: {
              code: 429,
              message: "rate limited",
              body: '{"error":{"message":"Rate limit reached for requests","type":"rate_limit"}}',
            },
          };
      });
      c.duration = segs.reduce((a, s) => a + s.audio.duration, 0) + silenceOf(segs, DEFAULT_PACING);
    }
    // the tail is scripted but not narrated, and the last chapter is back matter
    const last = chs[chs.length - 1];
    last.title = "Author’s afterword and release schedule";
    last.note = noteOf("afterword", undefined, 0);
    last.excluded = true;
    chs[212].title = "Interlude · A Letter Left at the Ninth Gate (bonus)";
  }

  // a chapter worth skipping: translator notes at the end of Drowned City
  const notes = w.chapters.drowned[w.chapters.drowned.length - 1];
  notes.title = "Translator’s notes";
  notes.note = noteOf("translator");
  notes.excluded = true;
  notes.words = 900;
}
