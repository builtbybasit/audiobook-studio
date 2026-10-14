// Per-book pronunciation dictionaries: names TTS gets wrong. Only requests carry the respelling.
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
