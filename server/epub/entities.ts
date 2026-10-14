// The EPUB library parses chapters as XML without reading DTDs, so `&nbsp;` would survive as
// literal text and be read aloud. Before parsing, HTML named entities become numeric references.
import { decodeHTMLStrict } from "entities";

/** The names XML defines itself, which the parser already reads correctly. */
const XML = new Set(["amp", "lt", "gt", "quot", "apos"]);

/** `&name;`; XML requires the semicolon. */
const NAMED = /&([A-Za-z][A-Za-z0-9]{0,31});/g;

export function numericEntities(xml: string): string {
  return xml.replace(NAMED, (ref, name: string) => {
    if (XML.has(name)) return ref;
    const decoded = decodeHTMLStrict(ref);
    if (decoded === ref) return ref;
    // A few names are two characters — `&NotEqualTilde;` is a symbol and a combining mark.
    return Array.from(decoded, (ch) => `&#${ch.codePointAt(0)};`).join("");
  });
}
