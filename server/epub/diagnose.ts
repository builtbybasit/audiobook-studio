// Why an EPUB could not be read, via EPUBCheck (names the resource and line). Run only after an
// import failed or lost something, never as a gate: many non-conformant books read fine.
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
 * What is wrong with this file, as a sentence to show beside the refusal. Undefined when the
 * validator has nothing to add or throws: an error path must not gain a second way to fail.
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
