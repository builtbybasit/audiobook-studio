// Why an EPUB could not be read, in the file's own terms.
//
// The parser can only report what stopped it — "could not be opened", "no readable chapters" —
// which tells somebody holding a broken file nothing they can act on. EPUBCheck knows: it validates
// the package against the spec and names the resource, the document and the line.
//
// It is run **only when the import has already failed or lost something**, never as a gate. Its own
// measured agreement with the reference implementation is 95.9%, and plenty of real books are
// technically non-conformant and read perfectly well — this project's own test fixtures among them.
// Refusing a book because a validator disliked its metadata would turn a working import into a
// support question. Explaining a failure it already had costs a person nothing.
import { EpubCheck } from "@likecoin/epubcheck-ts";

/** How many complaints are worth putting in front of somebody at once. */
const SHOWN = 3;

interface Message {
  id?: string;
  severity?: string;
  message?: string;
  location?: { path?: string; line?: number };
}

/** `RSC-001: Referenced resource "c2.xhtml" could not be found (OEBPS/content.opf line 12)` */
function describe(m: Message): string {
  const where = [m.location?.path, m.location?.line && `line ${m.location.line}`]
    .filter(Boolean)
    .join(" ");
  return [m.id && `${m.id}:`, m.message, where && `(${where})`].filter(Boolean).join(" ");
}

/**
 * What is wrong with this file, as a sentence to show beside the refusal.
 *
 * Returns nothing when the validator has nothing to add — including when it throws, which it may
 * do on input too damaged to validate. A diagnosis is a courtesy on an error path, and an error
 * path is the worst place to introduce a second way to fail.
 */
export async function diagnose(bytes: ArrayBuffer): Promise<string | undefined> {
  let messages: Message[];
  try {
    const result = await EpubCheck.validate(new Uint8Array(bytes));
    messages = (result.messages ?? []) as Message[];
  } catch {
    return undefined;
  }

  const serious = messages.filter((m) => {
    const severity = (m.severity ?? "").toLowerCase();
    return severity === "fatal" || severity === "error";
  });
  if (!serious.length) return undefined;

  const shown = serious.slice(0, SHOWN).map(describe);
  const rest = serious.length - shown.length;
  return [
    `EPUBCheck reports ${serious.length} problem${serious.length === 1 ? "" : "s"} with this file:`,
    ...shown,
    rest > 0 && `…and ${rest} more.`,
  ]
    .filter(Boolean)
    .join(" ");
}
