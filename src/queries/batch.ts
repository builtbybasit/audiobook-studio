// Many one-chapter reads as a few requests.
//
// A page that prices, searches or narrates hundreds of chapters asks for each one's text or script
// as its own query, which is what keeps each one cached and invalidated on its own. Sent as asked,
// a long book is thousands of requests at once — more than a browser holds open, so some fail —
// and thousands of answers landing one by one, each re-running whatever reads them. So the reads
// asked for in the same tick go out together, `MAX` chapters to a request, and each request's
// answers land together.
import { ApiError } from "@/services/http";

/** Chapters to one request: well under the server's limit, and a few requests for a long book. */
const MAX = 200;

type Waiter<T> = { resolve: (value: T) => void; reject: (cause: unknown) => void };

/**
 * One chapter's read through `load`, which reads several chapters of one `group` (a book, or a book
 * and a format) at once and leaves out a chapter it does not have.
 */
export function batchReads<T>(
  load: (group: string, ids: number[]) => Promise<Record<number, T>>,
): (group: string, id: number) => Promise<T> {
  let waiting: Map<string, Map<number, Waiter<T>[]>> | null = null;

  function send(group: string, ids: number[], waiters: Map<number, Waiter<T>[]>) {
    load(group, ids).then(
      (found) => {
        for (const id of ids) {
          const value = found[id];
          for (const w of waiters.get(id)!)
            if (value === undefined) w.reject(new ApiError("No such chapter", 404));
            else w.resolve(value);
        }
      },
      (cause) => {
        for (const id of ids) for (const w of waiters.get(id)!) w.reject(cause);
      },
    );
  }

  function flush() {
    const groups = waiting!;
    waiting = null;
    for (const [group, waiters] of groups) {
      const ids = [...waiters.keys()];
      for (let i = 0; i < ids.length; i += MAX) send(group, ids.slice(i, i + MAX), waiters);
    }
  }

  return (group, id) =>
    new Promise<T>((resolve, reject) => {
      if (!waiting) {
        waiting = new Map();
        queueMicrotask(flush);
      }
      let waiters = waiting.get(group);
      if (!waiters) waiting.set(group, (waiters = new Map()));
      const list = waiters.get(id);
      if (list) list.push({ resolve, reject });
      else waiters.set(id, [{ resolve, reject }]);
    });
}
