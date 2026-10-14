// The demo's clips, made on first read: writing thousands at seed time would be hundreds of MB.
// Each is the simulated endpoint's tone at the speaker's pitch, with the row's duration and rate
// (builds and the player trust the row). Only WAV, and only urls a clip row holds.
import { formatOfFile, type MakeClip } from "~/audio/files";
import type { Db } from "~/db/client";
import { clipByUrl } from "~/db/script";
import { SAMPLE_RATE, toneOf, toneWav } from "~/providers/fakeSpeech";

/** Makes a clip's file from its row in this database. */
export function demoClips(db: Db): MakeClip {
  return (bookId, url) => {
    if (formatOfFile(url) !== "wav") return null;
    const clip = clipByUrl(db, bookId, url);
    return clip ? toneWav(toneOf(clip.speaker), clip.duration, clip.rate ?? SAMPLE_RATE) : null;
  };
}
