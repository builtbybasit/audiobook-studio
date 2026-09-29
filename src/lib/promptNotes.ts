// Notes a prompt would not send, said where the notes are typed.
//
// A book's notes and an endpoint's are placed where the prompt says `{{book.notes}}` or
// `{{endpoint.notes}}`; a prompt without the tag drops them (see `@/lib/prompt`). Which notes are
// dropped is `unplacedNotes`'s; this says so in words, names whose prompt it is, and offers the
// line that places them when the prompt is one the page can change there and then.
import type { PromptOrigin, ResolvedPrompt } from "@/types";
import { unplacedNotes } from "@/lib/prompt";

export type NotesOwner = "book" | "endpoint";

/** The line "Add the tag" puts at the end of the system prompt, as the built-in prompt words it. */
export const NOTES_LINE: Record<NotesOwner, string> = {
  book: "Notes on this book: {{book.notes}}",
  endpoint: "Notes for this model: {{endpoint.notes}}",
};

export interface DroppedNotes {
  owner: NotesOwner;
  /** "This book's prompt has no {{endpoint.notes}}, so DeepSeek's notes for its model are not sent." */
  text: string;
  /** where the tag would have to go, when it cannot be added from here; empty when it can */
  fixElsewhere: string;
}

/**
 * Which of a book's and an endpoint's notes the prompt a run would send drops, and why. `here` is
 * the origin whose text the page is editing — "Add the tag" is offered only for that one.
 */
export function droppedNotes(
  resolved: ResolvedPrompt,
  notes: { book?: string; endpoint?: string },
  endpointName: string,
  here: PromptOrigin["from"],
): DroppedNotes[] {
  const from = resolved.origin.from;
  const name = endpointName.trim() || "the endpoint";
  const whose: Record<PromptOrigin["from"], string> = {
    book: "This book's prompt",
    endpoint: `${name}'s own prompt`,
    library: "The library's prompt",
    "built-in": "The built-in prompt",
  };
  const where: Record<PromptOrigin["from"], string> = {
    book: "this book's prompt",
    endpoint: `${name}'s Prompt tab on the Endpoints page`,
    library: "the library's prompt on the Endpoints page",
    "built-in": "the library's prompt on the Endpoints page",
  };
  return unplacedNotes(resolved, notes).map((owner) => ({
    owner,
    text: `${whose[from]} has no {{${owner}.notes}}, so ${
      owner === "book" ? "this book's notes are" : `${name}'s notes for its model are`
    } not sent.`,
    fixElsewhere: from === here ? "" : where[from],
  }));
}

/** A system prompt with the line that places `owner`'s notes added at its end. */
export function withNotesLine(system: string, owner: NotesOwner): string {
  const body = system.trimEnd();
  if (!body) return NOTES_LINE[owner];
  // beside the other notes line when the prompt ends on one, as the built-in prompt keeps them
  const last = body.slice(body.lastIndexOf("\n") + 1);
  const other = NOTES_LINE[owner === "book" ? "endpoint" : "book"];
  return `${body}${last === other ? "\n" : "\n\n"}${NOTES_LINE[owner]}`;
}
