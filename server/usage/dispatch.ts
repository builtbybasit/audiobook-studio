// One request's money, from the moment it is let go out to the moment its cost is in the ledger.
//
// A request that goes to a provider is held against the budgets at its worst case while it is out
// (`~/usage/budget`): against its endpoint's daily limit, and — when a job sent it — against the
// book's cap, through what the job holds. What the provider says about it comes back through
// `sent` (`~/providers/sent`) and is priced into the ledger (`~/usage/ledger`), and what it held
// is then given back: its charge at once, so what a request has spent is never also still held
// while the next one asks the budget, and the rest once the request is over, whichever way it
// ended. Every caller — a narration line, a scripting chunk, a clip heard back, a prompt trial, a
// voice sample, a sample transcript — goes through here, so that order is kept in one place.
//
// The rules a dispatch keeps for all of them:
//
// - **Priced at the rates stored when it settles.** The endpoint is read again as the report
//   lands, so a rate edited mid-run applies to what completes after it; one removed since is priced
//   by the snapshot it was sent with, because the money was spent all the same.
// - **Filed where the work is now.** A chapter removed mid-request is still where the money went
//   and its frozen label says which, but the row no longer points at it. A book removed
//   mid-request has nothing to file it under, and the row is left out.
// - **An outcome nobody can price keeps what it held.** A request answered without saying what it
//   used, or cancelled once it was out, costs what nobody knows rather than $0, and its row keeps
//   the hold for the budgets to count in its place; on a card that charges nothing for it at all
//   (a worst case of $0) it is known to be free. A request cancelled before it left reports
//   nothing, and so leaves nothing: it never happened as far as the provider is concerned.
import type { Endpoint, EndpointKind, Profile, RequestRecord, Transcriber } from "@/types";
import type { Db } from "~/db/client";
import { getBook, locateChapter } from "~/db/library";
import type { SentScript, SentSpeech, SentTranscription } from "~/providers/sent";
import { endpointOf, holdToday } from "~/usage/budget";
import { settleScript, settleSpeech, settleTranscription, type RequestFor } from "~/usage/ledger";

/** What each kind of endpoint is, and what its provider reports about a request. */
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
  /** what the request is for; the chapter by the uid it had when it was sent */
  work: Omit<RequestFor, "held" | "free">;
  /** its worst case, undiscounted, in USD: what it holds while it is out */
  hold: number;
  /**
   * Told each amount given back, for a job that holds the same amount against its book and keeps
   * that in step.
   */
  gaveBack?(amount: number): void;
}

export interface Dispatch<K extends EndpointKind> {
  /**
   * Handed to the provider as its `sent`: prices one report into the ledger and gives back its
   * charge. A request in parts — a long line cut to fit — reports once per part, all against the
   * one hold. The row appended, or null when the book has gone.
   */
  sent(report: Kinds[K]["sent"]): RequestRecord | null;
  /** The request is over, however it ended: give back what it still holds. Safe to call again. */
  release(): void;
}

/** Hold a request's worst case while it is out, and settle what it reports; see the header. */
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
      // a charge nobody knows is counted at what the request still holds, which it then gives back
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
