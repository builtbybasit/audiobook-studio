// The excerpts the live scripting tests send a real model, and what each script must say.
import { expect } from "bun:test";

import type { PromptCastMember } from "@/lib/prompt";
import { wordsOf } from "@/lib/gaps";
import { fidelity } from "~/providers/chatScripting";
import type { ScriptedLine } from "~/providers/scripting";

/** One line the script must have: the line holding `words`, of this type and/or speaker. */
interface Check {
  words: string;
  speaker?: string;
  type?: ScriptedLine["type"];
}

export interface LiveCase {
  id: string;
  title: string;
  /** the known cast sent with it, Narrator included */
  cast: string[];
  /** cast entries that are another's disguise: persona name → character */
  personas?: Record<string, string>;
  text: string;
  checks: Check[];
}

const INN: LiveCase = {
  id: "inn",
  title: "The Inn at the Ford",
  cast: ["Narrator", "Mara"],
  text: `The rain had not stopped since noon, and the inn's common room smelled of wet wool and woodsmoke. Mara pushed the door shut with her shoulder and shook out her cloak.

“You're late,” said Tobiah from the corner table. He did not look up from his cards.

“The bridge was out.” She dropped into the chair opposite him. “I had to go round by the mill, and the miller's dog took a dislike to me.”

“It takes a dislike to everyone.” He laid down a card, frowned at it, and picked it up again. “Did anyone follow you?”

Mara thought of the rider on the ridge road, the one who had kept his distance for three miles and then vanished. No, she told herself. Nobody would come this far for a letter.

“No,” she said quietly. “Nobody followed me.”

Tobiah finally raised his eyes. “Then why are you still holding your knife?”`,
  checks: [
    { words: "You're late", speaker: "Tobiah" },
    { words: "The bridge was out", speaker: "Mara" },
    { words: "It takes a dislike", speaker: "Tobiah" },
    { words: "Nobody followed me", speaker: "Mara" },
    { words: "still holding your knife", speaker: "Tobiah" },
    { words: "said Tobiah", type: "narration" },
  ],
};

/** Thoughts, a speaker never named beside a line, and a newcomer the cast does not have. */
const LETTER: LiveCase = {
  id: "letter",
  title: "The Cracked Seal",
  cast: ["Narrator", "Wren", "Hal"],
  text: `Wren held the letter up to the lamp. The seal was cracked, though she had not broken it.

“Who opened this?” she asked.

Old Hal shrugged and went on mending the net. “Came that way.”

“It did not come that way.” Wren turned it over. “Someone read it, Hal, and then they tried to close it again.”

“Maybe the courier.”

“Maybe.” She tucked it into her sleeve. He knows more than he says, she thought. He always does.

The door banged open and a boy no older than ten stumbled in, out of breath. “Miss Wren! The boats are back early, all of them.”

“All of them?” said Hal, and for the first time that evening he put the net down.`,
  checks: [
    { words: "Who opened this", speaker: "Wren" },
    { words: "she asked", type: "narration" },
    { words: "Came that way", speaker: "Hal" },
    { words: "tried to close it", speaker: "Wren" },
    { words: "Maybe the courier", speaker: "Hal" },
    { words: "He knows more than he says", speaker: "Wren", type: "thought" },
    { words: "The boats are back", type: "dialogue" },
    { words: "All of them?", speaker: "Hal" },
  ],
};

/** A quote broken by its tag, website text dropped mid-paragraph, and a translator's note. */
const CARGO: LiveCase = {
  id: "cargo",
  title: "Lost Cargo",
  cast: ["Narrator", "Reyes", "Jun"],
  text: `“If you're going to lie to me,” said Captain Reyes, “at least make it a good one.”

Jun spread his hands. “I'm not lying. The cargo was gone when I got there.”

The captain's eyes narrowed. Read the latest chapters at novelhaven dot com. She had known Jun for six years, and in all that time he had never once looked her in the eye when he was telling the truth.

(TL note: the raw says "since the flood" rather than "six years".)

“Then where,” she said slowly, “is my money?”`,
  checks: [
    { words: "If you're going to lie", speaker: "Reyes" },
    { words: "said Captain Reyes", type: "narration" },
    { words: "at least make it a good one", speaker: "Reyes" },
    { words: "I'm not lying", speaker: "Jun" },
    { words: "novelhaven", type: "watermark" },
    { words: "TL note", type: "note" },
    { words: "is my money", speaker: "Reyes" },
  ],
};

/** A persona: the disguise speaks as itself, thinks as the character, and is dropped with the mask. */
const MASK: LiveCase = {
  id: "mask",
  title: "The Grey Fox",
  cast: ["Narrator", "Lin", "The Grey Fox", "Odo"],
  personas: { "The Grey Fox": "Lin" },
  text: `The guards parted as Lin stepped into the hall, the fox mask cold against his face. A dozen nobles fell silent.

“You asked for the Grey Fox,” Lin said, his voice pitched low. “Here I am.”

Captain Odo rose from the high table. “You're smaller than the stories say.”

“The stories exaggerate.” Lin let the silence stretch. Don't look at the door, he told himself. Don't look at Mei.

“Name your price, thief.”

“Your seal, and the prisoner in your tower.”

Later, in the alley behind the stables, Lin pulled the mask off and leaned against the wall. Mei was waiting for him, arms folded.

“That was reckless,” she said.

“It worked, didn't it?” Lin said, grinning.`,
  checks: [
    { words: "You asked for the Grey Fox", speaker: "The Grey Fox" },
    { words: "Lin said, his voice pitched low", type: "narration" },
    { words: "smaller than the stories", speaker: "Odo" },
    { words: "The stories exaggerate", speaker: "The Grey Fox" },
    { words: "Don't look at the door", speaker: "Lin", type: "thought" },
    { words: "Name your price", speaker: "Odo" },
    { words: "Your seal, and the prisoner", speaker: "The Grey Fox" },
    { words: "That was reckless", speaker: "Mei" },
    { words: "It worked", speaker: "Lin" },
  ],
};

export const LIVE_CASES = [INN, LETTER, CARGO, MASK];

/** The excerpt the one-shot live tests send. */
export const EXCERPT = INN.text;

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

const straight = (s: string) => s.replace(/[‘’]/g, "'");

/** What is wrong with a script of `c`: words lost or added, and each check it fails. */
export function problemsOf(c: LiveCase, lines: ScriptedLine[]): string[] {
  const problems: string[] = [];
  const f = fidelity(c.text, lines);
  if (f.missing || f.added) {
    const left = wordsOf(c.text);
    const added = lines
      .flatMap((l) => wordsOf(l.text))
      .filter((w) => (left.includes(w) ? (left.splice(left.indexOf(w), 1), false) : true));
    problems.push(
      `words: ${f.missing} missing (${f.examples.join(" ")}), ${f.added} added (${added.slice(0, 8).join(" ")})`,
    );
  }
  const paragraphs = c.text.split(/\n\s*\n/).map((p) => ` ${wordsOf(p).join(" ")} `);
  for (const l of lines) {
    const run = ` ${wordsOf(l.text).join(" ")} `;
    if (run.trim() && !paragraphs.some((p) => p.includes(run)))
      problems.push(`"${l.text.slice(0, 40)}": runs across a paragraph break`);
  }
  for (const { words, speaker, type } of c.checks) {
    const line = lines.find((l) => straight(l.text).includes(straight(words)));
    if (!line) problems.push(`"${words}": no line`);
    else if ((speaker && line.speaker !== speaker) || (type && line.type !== type))
      problems.push(`"${words}": ${line.type} by ${line.speaker}`);
  }
  return problems;
}

/** Every word of the Inn excerpt, and each quote given to whoever says it. */
export function expectTheInn(lines: ScriptedLine[]): void {
  expect(problemsOf(INN, lines)).toEqual([]);
}
