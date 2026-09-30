// The demo's clips, made the first time something reads them.
//
// The demo is seeded with a whole world already narrated — thousands of lines — and a tone written
// for each at seed time would be hundreds of megabytes, most of which nobody plays. So the seed
// writes each clip's row with a url in the demo's usual form and no file behind it, and the file is
// made here when the player, a build or anything else first asks for it: the tone a simulated
// endpoint answers with, at the pitch of the line's speaker, as long as the row says the clip is
// and at the rate it says the clip came back at. A build reads the rate off the row to refuse mixed
// rates, and a player times the chapter by the row's duration, so a file that disagreed with its
// row would be a clip that lies about itself.
//
// Only a url a clip row holds is made, and only as a WAV, the one format the tone is written in: a
// name no clip holds stays the 404 it is in the real library.
import { formatOfFile, type MakeClip } from "~/audio/files";
import type { Db } from "~/db/client";
import { clipByUrl } from "~/db/script";
import { SAMPLE_RATE, toneOf, toneWav } from "~/providers/fakeSpeech";

/** What makes a clip's file from its row in this database; the demo library's files are given it. */
export function demoClips(db: Db): MakeClip {
  return (bookId, url) => {
    if (formatOfFile(url) !== "wav") return null;
    const clip = clipByUrl(db, bookId, url);
    return clip ? toneWav(toneOf(clip.speaker), clip.duration, clip.rate ?? SAMPLE_RATE) : null;
  };
}
