// Per-book pronunciation dictionaries. These are the names a TTS engine reliably gets wrong; the
// prose keeps the author's spelling and only the request carries the respelling.
//
// A factory, so an entry edited or disabled in one world is not an entry edited in the next.
import type { LexEntry } from "@/types";

export function makeLexicon(): Record<string, LexEntry[]> {
  return {
    cliche: [
      { id: 1, term: "Ji Ning", say: "Jee Ning", ipa: "dʒiː nɪŋ", enabled: true },
      { id: 2, term: "Lan’er", say: "Lahn-urr", enabled: true, note: "one name, not two words" },
      {
        id: 3,
        term: "Qi",
        say: "chee",
        enabled: false,
        matchCase: true,
        note: "off: the chapter titles read fine, and lower-case “qi” is rare",
      },
      {
        id: 4,
        term: "outer sect",
        say: "外门",
        enabled: true,
        note:
          "the Hanzi is what a bilingual model reads correctly — and it is 2 characters but 6 " +
          "UTF-8 bytes, which is the quantity Fish Audio actually bills on. The book keeps the " +
          "English; only the request carries this.",
      },
    ],
    starforge: [{ id: 1, term: "Ocho", say: "Oh-cho", enabled: true }],
    drowned: [{ id: 1, term: "Tobiah", say: "Toe-BYE-uh", enabled: true }],
    gates: [{ id: 1, term: "Shen Yue", say: "Shun Yueh", enabled: true }],
  };
}
