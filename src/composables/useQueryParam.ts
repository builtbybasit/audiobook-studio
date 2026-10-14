// A piece of page state kept in the URL, so a reload or pasted link finds the same view. Synced
// both ways (`router.replace`, no history entry per keystroke); each side compares the value as the
// URL spells it before writing, so its own echo is not a second change. A codec spells one value.
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

/** One of a fixed set of words. The fallback is absent from the URL; unknown words read as it. */
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

/** Positive ids in ascending order, so one set is one address. `fallback` is what absent means. */
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
 * Set one query key together with any others set in the same tick: each `replace` spreads the
 * query as it stands until the navigation lands, so two separate writes would undo each other.
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
  // Leaving the page changes the query before the view goes; the next page's query is not ours.
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
