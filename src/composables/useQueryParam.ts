// A piece of page state kept in the URL, so leaving and coming back — or a reload, or a pasted link
// — finds the same view.
//
// The ref and the query are kept in step both ways: setting the ref rewrites the address with
// `router.replace` (no history entry per keystroke), and a navigation that changes the key sets the
// ref. Each direction compares the value as the URL would spell it before it writes, so the echo of
// its own write never comes back as a second change — which matters where an absent key means
// something (`default`), and an emptied value would otherwise read back as that default.
//
// A codec says how one value is spelled: `parse` reads the key's text, `serialize` writes it and
// answers `undefined` to leave the key out, and `default` is what an absent key means. The common
// ones are below; a page with an odd one passes its own.
import { ref, watch, type Ref } from "vue";
import { useRoute, useRouter, type LocationQueryRaw, type Router } from "vue-router";
import { queryIdSet, queryText } from "@/lib/query";

export interface QueryParam<T> {
  /** the value the key's text stands for; only asked when the key is present */
  parse: (text: string) => T;
  /** the text the URL carries for a value; `undefined` leaves the key out */
  serialize: (value: T) => string | undefined;
  /** what an absent key means */
  default: T | (() => T);
}

/** Free text. Empty is absent; `trim` keeps the spaces being typed out of the address. */
export function textParam({ trim = false } = {}): QueryParam<string> {
  return {
    parse: (text) => text,
    serialize: (value) => (trim ? value.trim() : value) || undefined,
    default: "",
  };
}

/** One of a fixed set of words. The fallback is absent from the URL, and anything unknown reads as it. */
export function enumParam<T extends string, F extends T | null>(
  values: readonly T[],
  fallback: F,
): QueryParam<T | F> {
  return {
    parse: (text) => (values.includes(text as T) ? (text as T) : fallback),
    serialize: (value) => (value === fallback || value == null ? undefined : value),
    default: fallback,
  };
}

/** One positive id, or none. */
export function idParam(): QueryParam<number | null> {
  return {
    parse: (text) => {
      const id = Number(text);
      return Number.isInteger(id) && id > 0 ? id : null;
    },
    serialize: (value) => (value == null ? undefined : String(value)),
    default: null,
  };
}

/**
 * A set of positive ids, written in ascending order so the same set is always the same address.
 * `fallback` is what an absent key means, when that is not "none".
 */
export function idSetParam(fallback: () => Set<number> = () => new Set()): QueryParam<Set<number>> {
  return {
    parse: (text) => queryIdSet(text),
    serialize: (ids) => [...ids].sort((a, b) => a - b).join(",") || undefined,
    default: fallback,
  };
}

/** Keys set in one tick, waiting to go out together. */
const pending = new WeakMap<Router, LocationQueryRaw>();

/**
 * Set one key of the query, together with any other set in the same tick. Each `replace` spreads
 * the query as it stands, and the route only moves once the navigation lands — so two written one
 * after the other would each put back what the other took out ("show everything" clearing the
 * search and the filter kept one of them).
 */
function writeQuery(router: Router, name: string, text: string | undefined): void {
  let patch = pending.get(router);
  if (!patch) {
    const fresh: LocationQueryRaw = {};
    pending.set(router, fresh);
    patch = fresh;
    queueMicrotask(() => {
      pending.delete(router);
      void router.replace({ query: { ...router.currentRoute.value.query, ...fresh } });
    });
  }
  patch[name] = text;
}

export function useQueryParam<T>(name: string, param: QueryParam<T>): Ref<T> {
  const route = useRoute();
  const router = useRouter();
  // The page this state belongs to. Leaving it changes the query before the view goes away, and
  // what the next page has in its address is not this page's to read or to rewrite.
  const path = route.path;
  const absent = (): T =>
    typeof param.default === "function" ? (param.default as () => T)() : param.default;
  const inUrl = (): string | undefined => {
    const raw = route.query[name];
    return raw == null ? undefined : queryText(raw);
  };
  const read = (): T => {
    const text = inUrl();
    return text === undefined ? absent() : param.parse(text);
  };

  const value = ref(read()) as Ref<T>;
  watch(value, (next) => {
    if (route.path !== path) return;
    const text = param.serialize(next);
    if (text !== inUrl()) writeQuery(router, name, text);
  });
  watch(
    () => route.query[name],
    () => {
      if (route.path !== path || inUrl() === param.serialize(value.value)) return;
      value.value = read();
    },
  );
  return value;
}
