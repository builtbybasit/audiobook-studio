// Resolve a fact's paragraph numbers to the chapter's own text, saved as its evidence. This checks
// the source, not the model's reading of it; the saved passage lets a reader judge that.
import type { PromptCastMember } from "@/lib/prompt";
import { sourceParagraphs } from "@/lib/sourceParagraphs";

/** The facts citing 1–5 paragraphs that exist (and are in `allowedIds`), with their text. */
export function groundedFacts<T extends NonNullable<PromptCastMember["facts"]>[number]>(
  facts: readonly T[],
  source: string,
  allowedIds?: ReadonlySet<number>,
): (T & { sourceIds: number[]; evidence: string })[] {
  const paragraphs = new Map(sourceParagraphs(source).map((p) => [p.id, p.text]));
  return facts.flatMap((f) => {
    const ids = f.sourceIds ?? [];
    if (
      !ids.length ||
      ids.length > 5 ||
      ids.some(
        (id) =>
          !Number.isSafeInteger(id) || !paragraphs.has(id) || (allowedIds && !allowedIds.has(id)),
      )
    )
      return [];
    const sourceIds = [...new Set(ids)].sort((a, b) => a - b);
    return [{ ...f, sourceIds, evidence: sourceIds.map((id) => paragraphs.get(id)!).join("\n\n") }];
  });
}
