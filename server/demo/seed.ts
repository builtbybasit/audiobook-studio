// What the demo library starts with, and goes back to on a reset.
//
// The Simulated speech endpoint and the Simulated scripting profile, so a run can be tried end to
// end with nothing billed and nothing sent anywhere; and one short book, already through its
// contents review, to try it on. The endpoint and the profile are the presets' own `apply` — what
// the Endpoints page fills in when the preset is picked — checked by the schemas the save route
// checks with and saved the way it saves them, so the demo's endpoints are ones a person could
// have made. The book is assembled the way an import assembles one, from chapters written here
// rather than an EPUB read: there is no file to keep for it, and nothing about a parse to show.
import * as v from "valibot";

import { presetById, scriptingPresetById, type Preset } from "@/lib/presets";
import { newProfile } from "@/lib/scripting";
import type { Db } from "~/db/client";
import * as library from "~/db/library";
import { books, endpoints } from "~/db/schema";
import { saveEndpoints } from "~/endpoints/ops";
import type { ParsedEpub } from "~/epub/parse";
import { countWords } from "~/epub/text";
import { assembleBook } from "~/import/assemble";
import { EndpointSchema, ProfileSchema } from "~/lib/schemas";
import type { VoiceFiles } from "~/voices/files";

/** What a seed put in, by id, for the reset's answer and the boot log. */
export interface Seeded {
  endpoints: string[];
  profiles: string[];
  books: string[];
}

/** The id the Simulated endpoint and the Simulated profile are both kept under. */
export const SIMULATED_ID = "simulated";

/** A preset's fields, as a copy the seed can hand on without sharing the catalogue's objects. */
function applied<T>(preset: Preset<T> | undefined): Partial<T> {
  if (!preset) throw new Error("The Simulated preset the demo is seeded from is missing");
  return structuredClone(preset.apply);
}

const speechEndpoint = () =>
  v.parse(EndpointSchema, {
    id: SIMULATED_ID,
    enabled: true,
    ...applied(presetById("simulated")),
  });

const scriptingProfile = () =>
  v.parse(
    ProfileSchema,
    newProfile({ ...applied(scriptingPresetById("simulated")), id: SIMULATED_ID }),
  );

const chapter = (title: string, paragraphs: string[], n: number) => {
  const text = paragraphs.join("\n\n");
  return { title, text, words: countWords(text), href: `c${n}.xhtml` };
};

/** The demo's book: short, with a few speakers named beside what they say, for the script to find. */
const BOOK: ParsedEpub = {
  title: "The Lamp at Gull Rock",
  author: "Wren Halloway",
  language: "en",
  chapters: [
    chapter(
      "The Wick",
      [
        "The wind came off the sea an hour before dark, and by the time Nell had climbed the tower the glass was streaked with salt.",
        "“Is it lit?” asked Tobias from the foot of the stairs.",
        "“Not yet,” said Nell. “The wick is damp again.”",
        "He came up slowly, one hand on the rail, and took the matches from her. “Then we dry it,” said Tobias. “A lamp that waits for good weather is no lamp at all.”",
        "Out on the water, a single light was moving toward the rocks.",
      ],
      1,
    ),
    chapter(
      "The Boat",
      [
        "By midnight the light had become a boat, and the boat had become three men bailing with their hats.",
        "“They will never clear the point,” said Nell.",
        "“They will if they can see it,” said Tobias, and turned the lamp a quarter toward the reef.",
        "The boat swung with it. For a long minute it hung on the white water, and then it was through, and the men were shouting something the wind took away.",
        "In the morning one of them climbed the hill with a basket of fish. “We saw your light,” said the fisherman. “We thought the rock had moved.”",
      ],
      2,
    ),
  ],
};

const BOOK_ID = "the-lamp-at-gull-rock";

/** A library nobody has used yet: no endpoint of either kind, and no book. */
export function isFresh(db: Db): boolean {
  return !db.select().from(endpoints).get() && !db.select().from(books).get();
}

/** Put the demo's endpoints and book into a library with none. */
export function seedDemo(db: Db, voiceFiles: VoiceFiles): Seeded {
  const config = {
    endpoints: [speechEndpoint()],
    profiles: [scriptingProfile()],
    credentials: [],
  };
  saveEndpoints(db, config, voiceFiles);

  const { book, chapters, bodies } = assembleBook(BOOK, BOOK_ID, `${BOOK_ID}.epub`);
  library.insertBook(db, book, chapters, bodies);
  library.confirmImport(db, book.id);

  return {
    endpoints: config.endpoints.map((e) => e.id),
    profiles: config.profiles.map((p) => p.id),
    books: [book.id],
  };
}
