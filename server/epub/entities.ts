// HTML's named entities, in a document an XML parser is about to read.
//
// A chapter file is XHTML, and the EPUB library parses it as XML. XML knows five named entities —
// `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;` — and every other name is one the document's DTD
// declares. The parser does not read DTDs, so `&nbsp;`, `&mdash;` and `&hellip;` are left as
// the literal text `&nbsp;`, stored, counted as words and read aloud by the narrator. EPUB 2 and
// Calibre books with an XHTML 1.1 doctype use them all the time.
//
// So before a document is parsed, each HTML name is replaced by the numeric reference for the
// same character — `&nbsp;` by `&#160;` — which is what a parser that read the DTD would have
// made of it, and which every XML parser understands. The table is `entities`', which is the
// full HTML list; a name that is not on it is left alone, for the parser to treat as it did.
import { decodeHTMLStrict } from "entities";

/** The names XML defines itself, which the parser already reads correctly. */
const XML = new Set(["amp", "lt", "gt", "quot", "apos"]);

/** `&name;` — with the semicolon, which is what makes it an entity in XML. */
const NAMED = /&([A-Za-z][A-Za-z0-9]{0,31});/g;

/** A document's HTML named entities, as numeric references an XML parser knows. */
export function numericEntities(xml: string): string {
  return xml.replace(NAMED, (ref, name: string) => {
    if (XML.has(name)) return ref;
    const decoded = decodeHTMLStrict(ref);
    if (decoded === ref) return ref;
    // A few names are two characters — `&NotEqualTilde;` is a symbol and a combining mark.
    return Array.from(decoded, (ch) => `&#${ch.codePointAt(0)};`).join("");
  });
}
