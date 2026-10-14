// Many one-chapter reads as a few requests. Each chapter stays its own query (cached and
// invalidated alone), but reads asked in the same tick go out together, `MAX` to a request: a long
// book read one by one is thousands of requests, more than a browser holds open.
import { ApiError } from "@/services/http";

/** Chapters to one request: well under the server's limit, and a few requests for a long book. */
const MAX = 200;

type Waiter<T> = { resolve: (value: T) => void; reject: (cause: unknown) => void };

/** One chapter's read through `load`, which reads several chapters of one `group` at once and
 *  leaves out ones it does not have. */
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
