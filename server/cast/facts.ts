// Resolve paragraph IDs to original prose, or check legacy quotes. This validates the source,
// not the model's interpretation; the saved snapshot lets a reader inspect that interpretation.
import type { PromptCastMember } from "@/lib/prompt";
import { sourceParagraphs } from "@/lib/sourceParagraphs";

const normalized = (s: string): string => s.replace(/\s+/g, " ").trim();

export function groundedFacts<T extends NonNullable<PromptCastMember["facts"]>[number]>(
  facts: readonly T[],
  source: string,
  allowedIds?: ReadonlySet<number>,
): (T & { evidence: string })[] {
  const paragraphs = new Map(sourceParagraphs(source).map((p) => [p.id, p.text]));
  return facts.flatMap((f) => {
    if (f.sourceIds !== undefined) {
      const ids = f.sourceIds;
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
      return [
        { ...f, sourceIds, evidence: sourceIds.map((id) => paragraphs.get(id)!).join("\n\n") },
      ];
    }
    const quote = normalized(f.evidence ?? "");
    if (!quote || quote.length > 1000) return [];
    // Match typography only, never changed words; save the original source substring.
    const pattern = (quote.match(/\.\.\.|[\s\S]/gu) ?? [])
      .map((c) =>
        c === " "
          ? "\\s+"
          : /['‘’]/u.test(c)
            ? "['‘’]"
            : /["“”]/u.test(c)
              ? '["“”]'
              : c === "…" || c === "..."
                ? "(?:\\.\\.\\.|…)"
                : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("");
    const evidence = source.match(new RegExp(pattern, "u"))?.[0];
    return evidence && evidence.length <= 1000 ? [{ ...f, evidence }] : [];
  });
}
