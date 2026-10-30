/** Stable, one-based IDs for nonempty prose blocks, including headings. Never reset per chunk. */
export interface SourceParagraph {
  id: number;
  text: string;
  from: number;
  to: number;
}

export function sourceParagraphs(source: string): SourceParagraph[] {
  const out: SourceParagraph[] = [];
  let from = 0;
  for (const block of source.split(/\n\s*\n/)) {
    const at = source.indexOf(block, from);
    const text = block.trim();
    if (text) {
      const start = at + block.indexOf(text);
      out.push({ id: out.length + 1, text, from: start, to: start + text.length });
    }
    from = at + block.length;
  }
  return out;
}

export function paragraphsIn(
  source: string,
  offset = 0,
  length = source.length,
): SourceParagraph[] {
  return sourceParagraphs(source).filter((p) => p.to > offset && p.from < offset + length);
}

/** Only the requested slice is sent; a cut through a paragraph retains that paragraph's ID. */
export function numberedParagraphs(source: string, offset = 0, length = source.length): string {
  return paragraphsIn(source, offset, length)
    .map(
      (p) =>
        `[P${p.id}]\n${source.slice(Math.max(p.from, offset), Math.min(p.to, offset + length))}`,
    )
    .join("\n\n");
}
