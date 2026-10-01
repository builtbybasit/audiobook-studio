/** The strip's column is w-44, 176px: past 88 chapters a 1px gap between them leaves no chapter. */
const GAPPED_MAX = 88;

/**
 * A speaker's appearance strip — which of the book's chapters 1…`total` they speak in — as one
 * element's style, laid over the strip's grey: a violet band per run of consecutive chapters. It
 * was a span per chapter, 300,000 of them for a long book's cast. Up to 88 chapters the 1px gap
 * between chapters is cut out of it as the spans had it; past that a band is at least 1px wide, so
 * a speaker in one chapter of 878 still shows.
 */
export function appearanceStrip(
  chapters: ReadonlySet<number>,
  total: number,
): Record<string, string> {
  const gapped = total <= GAPPED_MAX;
  // where chapter k+1 starts: with gaps every chapter is (100% + 1px) / total wide, its gap included
  const at = (k: number) =>
    gapped ? `calc((100% + 1px) * ${k / total})` : `${(k / total) * 100}%`;
  const ids = [...chapters].filter((i) => i >= 1 && i <= total).sort((a, b) => a - b);
  const stops: string[] = [];
  for (let i = 0; i < ids.length;) {
    const first = ids[i]!;
    let last = first;
    while (ids[++i] === last + 1) last++;
    const start = at(first - 1);
    const end = gapped ? at(last) : `max(${at(last)}, calc(${start} + 1px))`;
    stops.push(
      `transparent ${start}`,
      `var(--color-violet-500) ${start} ${end}`,
      `transparent ${end}`,
    );
  }
  const style: Record<string, string> = {};
  if (stops.length) style.backgroundImage = `linear-gradient(to right, ${stops.join(", ")})`;
  if (gapped && total > 1) {
    const step = `calc((100% + 1px) / ${total})`;
    style.maskImage = `repeating-linear-gradient(to right, #000 0 calc(${step} - 1px), transparent 0 ${step})`;
  }
  return style;
}
