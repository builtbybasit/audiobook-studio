// Notes a prompt would not send (`unplacedNotes`), said in words where the notes are typed, with
// the line that places them when the page can edit that prompt.
import type { PromptOrigin, ResolvedPrompt } from "@/types";
import { unplacedNotes } from "@/lib/prompt";

export type NotesOwner = "book" | "endpoint";

/** As the built-in prompt words it. */
export const NOTES_LINE: Record<NotesOwner, string> = {
  book: "Notes on this book: {{book.notes}}",
  endpoint: "Notes for this model: {{endpoint.notes}}",
};

export interface DroppedNotes {
  owner: NotesOwner;
  /** "This book's prompt has no {{endpoint.notes}}, so DeepSeek's notes for its model are not sent." */
  text: string;
  /** where the tag would have to go; empty when it can be added from here */
  fixElsewhere: string;
}

/** `here` is the origin the page is editing; "Add the tag" is offered only for it. */
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

export function withNotesLine(system: string, owner: NotesOwner): string {
  const body = system.trimEnd();
  if (!body) return NOTES_LINE[owner];
  const last = body.slice(body.lastIndexOf("\n") + 1);
  const other = NOTES_LINE[owner === "book" ? "endpoint" : "book"];
  return `${body}${last === other ? "\n" : "\n\n"}${NOTES_LINE[owner]}`;
}
