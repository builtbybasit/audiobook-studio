// One request's money: held at its worst case against the budgets while out, priced into the
// ledger as each report lands, and the hold given back (the charge at once, the rest on release).
// Every provider call goes through here. Priced at the endpoint's rates when it settles (the sent
// snapshot if removed since). A chapter removed mid-request is unlinked; a removed book drops the
// row. A request cancelled before it left records nothing.
import type { Endpoint, EndpointKind, Profile, RequestRecord, Transcriber } from "@/types";
import type { Db } from "~/db/client";
import { getBook, locateChapter } from "~/db/library";
import type { SentScript, SentSpeech, SentTranscription } from "~/providers/sent";
import { endpointOf, holdToday } from "~/usage/budget";
import { settleScript, settleSpeech, settleTranscription, type RequestFor } from "~/usage/ledger";

interface Kinds {
  tts: { endpoint: Endpoint; sent: SentSpeech };
  scripting: { endpoint: Profile; sent: SentScript };
  transcription: { endpoint: Transcriber; sent: SentTranscription };
}

type Settle<K extends EndpointKind> = (
  db: Db,
  endpoint: Kinds[K]["endpoint"],
  work: RequestFor,
  sent: Kinds[K]["sent"],
) => RequestRecord;

const SETTLE: { [K in EndpointKind]: Settle<K> } = {
  tts: settleSpeech,
  scripting: settleScript,
  transcription: settleTranscription,
};

export interface DispatchOptions<K extends EndpointKind> {
  kind: K;
  /** the endpoint as it was when the request was sent */
  endpoint: Kinds[K]["endpoint"];
  work: Omit<RequestFor, "held" | "free">;
  /** worst case, undiscounted, in USD */
  hold: number;
  /** Told each amount given back, so a job can keep its book reservation in step. */
  gaveBack?(amount: number): void;
}

export interface Dispatch<K extends EndpointKind> {
  /**
   * The provider's `sent`: prices one report and gives back its charge. A request split into parts
   * reports once per part against the one hold. Null when the book has gone.
   */
  sent: (report: Kinds[K]["sent"]) => RequestRecord | null;
  /** Give back what is still held, however the request ended. Idempotent. */
  release: () => void;
}

export function dispatch<K extends EndpointKind>(db: Db, o: DispatchOptions<K>): Dispatch<K> {
  const { kind, endpoint, work, hold } = o;
  let left = Math.max(0, hold);
  const today = holdToday(db, kind, endpoint.id, left);
  const give = (amount: number): void => {
    const back = Math.min(left, Math.max(0, amount));
    if (!back) return;
    left -= back;
    today(back);
    o.gaveBack?.(back);
  };
  const settle = SETTLE[kind] as Settle<K>;
  return {
    sent(report) {
      if (work.bookId != null && !getBook(db, work.bookId)) return null;
      const current = (endpointOf(db, kind, endpoint.id) as Kinds[K]["endpoint"]) ?? endpoint;
      const chapterUid =
        work.chapterUid != null && locateChapter(db, work.chapterUid) ? work.chapterUid : null;
      // an unknown cost is counted at what is still held, which is then given back
      const record = settle(
        db,
        current,
        { ...work, chapterUid, held: left, free: hold <= 0 },
        report,
      );
      give(record.cost ?? left);
      return record;
    },
    release: () => give(left),
  };
}
