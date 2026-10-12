// The one excerpt the live scripting tests send a real model, and what its script must say.
import { expect } from "bun:test";

import type { PromptCastMember } from "@/lib/prompt";
import { fidelity } from "~/providers/chatScripting";
import type { ScriptedLine } from "~/providers/scripting";

export const EXCERPT = `The rain had not stopped since noon, and the inn's common room smelled of wet wool and woodsmoke. Mara pushed the door shut with her shoulder and shook out her cloak.

“You're late,” said Tobiah from the corner table. He did not look up from his cards.

“The bridge was out.” She dropped into the chair opposite him. “I had to go round by the mill, and the miller's dog took a dislike to me.”

“It takes a dislike to everyone.” He laid down a card, frowned at it, and picked it up again. “Did anyone follow you?”

Mara thought of the rider on the ridge road, the one who had kept his distance for three miles and then vanished. No, she told herself. Nobody would come this far for a letter.

“No,” she said quietly. “Nobody followed me.”

Tobiah finally raised his eyes. “Then why are you still holding your knife?”`;

/** The script printed, so a person can judge the attribution as well as the assertions. */
export function printScript(
  ms: number,
  lines: ScriptedLine[],
  cast?: PromptCastMember[],
  recap?: string,
): void {
  console.log(`${Math.round(ms)} ms, ${lines.length} lines`);
  for (const l of lines)
    console.log(
      `${l.type.padEnd(9)} ${l.speaker.padEnd(8)} ${l.direction ? `[${l.direction}] ` : ""}${l.text}`,
    );
  console.log("cast:", JSON.stringify(cast), "\nrecap:", recap);
}

/** Every word of `EXCERPT`, and each quote given to whoever says it. */
export function expectTheInn(lines: ScriptedLine[]): void {
  expect(fidelity(EXCERPT, lines).ok).toBe(true);
  const said = (words: string) => lines.find((l) => l.text.includes(words));
  expect(said("You're late")?.speaker ?? said("You’re late")?.speaker).toBe("Tobiah");
  expect(said("The bridge was out")?.speaker).toBe("Mara");
  expect(said("It takes a dislike")?.speaker).toBe("Tobiah");
  expect(said("Nobody followed me")?.speaker).toBe("Mara");
  expect(said("still holding your knife")?.speaker).toBe("Tobiah");
  expect(said("said Tobiah")?.type).toBe("narration");
}
