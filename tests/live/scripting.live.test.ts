// The chat-completions provider against a real model, opt-in: `LIVE=1 bun test tests/live`.
//
// The target is built from `SCRIPTING_PROVIDER_URL`, `SCRIPTING_PROVIDER_MODEL` and
// `SCRIPTING_PROVIDER_TOKEN` in `.env` — for this test only; the app itself reads a profile's
// address and key from the endpoints table. One excerpt, one request, and the answer printed so a
// person can judge the attribution as well as the assertions.
import { describe, expect, test } from "bun:test";

import { chatScriptingProvider, fidelity } from "~/providers/chatScripting";
import type { ScriptTarget } from "~/providers/scripting";

const EXCERPT = `The rain had not stopped since noon, and the inn's common room smelled of wet wool and woodsmoke. Mara pushed the door shut with her shoulder and shook out her cloak.

“You're late,” said Tobiah from the corner table. He did not look up from his cards.

“The bridge was out.” She dropped into the chair opposite him. “I had to go round by the mill, and the miller's dog took a dislike to me.”

“It takes a dislike to everyone.” He laid down a card, frowned at it, and picked it up again. “Did anyone follow you?”

Mara thought of the rider on the ridge road, the one who had kept his distance for three miles and then vanished. No, she told herself. Nobody would come this far for a letter.

“No,” she said quietly. “Nobody followed me.”

Tobiah finally raised his eyes. “Then why are you still holding your knife?”`;

const env = process.env;

describe.skipIf(!env.LIVE || !env.SCRIPTING_PROVIDER_URL)("a real scripting model", () => {
  const target: ScriptTarget = {
    id: "live",
    name: "Live scripting model",
    baseUrl: (env.SCRIPTING_PROVIDER_URL ?? "").replace(/\/+$/, ""),
    model: env.SCRIPTING_PROVIDER_MODEL ?? "",
    apiKey: env.SCRIPTING_PROVIDER_TOKEN || null,
    needsKey: false,
    timeoutSec: 120,
    maxRetries: 1,
    cooldownSec: 5,
    // none: a reasoning model spends part of any cap thinking, and this gateway counts that too
    maxOutputTokens: 0,
  };

  test(
    "scripts an excerpt word for word, with its speakers named",
    async () => {
      const started = performance.now();
      const lines = await chatScriptingProvider().script({
        title: "The Inn at the Ford",
        text: EXCERPT,
        signal: new AbortController().signal,
        target,
        cast: ["Narrator", "Mara"],
      });
      console.log(`${Math.round(performance.now() - started)} ms, ${lines.length} lines`);
      for (const l of lines)
        console.log(
          `${l.type.padEnd(9)} ${l.speaker.padEnd(8)} ${l.direction ? `[${l.direction}] ` : ""}${l.text}`,
        );

      expect(fidelity(EXCERPT, lines).ok).toBe(true);
      const said = (words: string) => lines.find((l) => l.text.includes(words));
      expect(said("You're late")?.speaker ?? said("You’re late")?.speaker).toBe("Tobiah");
      expect(said("The bridge was out")?.speaker).toBe("Mara");
      expect(said("It takes a dislike")?.speaker).toBe("Tobiah");
      expect(said("Nobody followed me")?.speaker).toBe("Mara");
      expect(said("still holding your knife")?.speaker).toBe("Tobiah");
      expect(said("said Tobiah")?.type).toBe("narration");
    },
    { timeout: 180_000 },
  );

  test(
    "answers the Test button",
    async () => {
      const result = await chatScriptingProvider().probe!(target, new AbortController().signal);
      console.log(result);
      expect(result.ok).toBe(true);
    },
    { timeout: 180_000 },
  );
});
