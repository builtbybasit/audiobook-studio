// Page state kept in the URL (`useQueryParam`): how each codec spells a value, and the two ways the
// ref and the address can fall out of step — two keys written in one tick, where each `replace`
// used to put back what the other took out, and a value emptied to where the key's absence means
// something else, which must not read back as that something else.
import { describe, expect, test } from "bun:test";
import { createApp, effectScope, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

import {
  enumParam,
  idParam,
  idSetParam,
  textParam,
  useQueryParam,
} from "@/composables/useQueryParam";

describe("codecs", () => {
  test("text leaves an empty value out, and trims only when asked", () => {
    expect(textParam().serialize("")).toBeUndefined();
    expect(textParam().serialize(" harbour ")).toBe(" harbour ");
    expect(textParam({ trim: true }).serialize("  ")).toBeUndefined();
    expect(textParam({ trim: true }).serialize(" harbour ")).toBe("harbour");
  });

  test("an enum reads anything unknown as its fallback, which the URL leaves out", () => {
    const filter = enumParam(["all", "ready", "stale"], "all");
    expect(filter.parse("stale")).toBe("stale");
    expect(filter.parse("nonsense")).toBe("all");
    expect(filter.serialize("all")).toBeUndefined();
    expect(filter.serialize("ready")).toBe("ready");
  });

  test("an id is one positive integer or none", () => {
    const id = idParam();
    expect(id.parse("12")).toBe(12);
    expect(["0", "-3", "1.5", "x", ""].map(id.parse)).toEqual([null, null, null, null, null]);
    expect(id.serialize(null)).toBeUndefined();
  });

  test("an id set is written in order, so the same set is the same address", () => {
    const ids = idSetParam();
    expect(ids.serialize(new Set([9, 2, 5]))).toBe("2,5,9");
    expect(ids.serialize(new Set())).toBeUndefined();
    expect(ids.parse("3, nope, 0, 7")).toEqual(new Set([3, 7]));
  });
});

async function page(query: Record<string, string> = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/page", component: {} }],
  });
  await router.push({ path: "/page", query });
  const app = createApp({}).use(router);
  const scope = effectScope();
  const use = <T>(fn: () => T): T => scope.run(() => app.runWithContext(fn))!;
  /** Let the watchers, the batched write and the navigation all land. */
  const settle = async () => {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { router, use, settle, stop: () => scope.stop() };
}

describe("useQueryParam", () => {
  test("keys changed in the same tick all reach the address", async () => {
    const { router, use, settle, stop } = await page({ find: "mist", filter: "stale" });
    const find = use(() => useQueryParam("find", textParam()));
    const filter = use(() => useQueryParam("filter", enumParam(["all", "stale"], "all")));
    expect([find.value, filter.value]).toEqual(["mist", "stale"]);

    find.value = "";
    filter.value = "all";
    await settle();
    expect(router.currentRoute.value.query).toEqual({});
    expect([find.value, filter.value]).toEqual(["", "all"]);
    stop();
  });

  test("a navigation sets the ref, and emptying a value does not bring its default back", async () => {
    const { router, use, settle, stop } = await page({ closed: "4" });
    // an absent key folds volumes 1 and 2, so an emptied set leaving the URL must not read as that
    const closed = use(() =>
      useQueryParam(
        "closed",
        idSetParam(() => new Set([1, 2])),
      ),
    );
    expect([...closed.value]).toEqual([4]);

    closed.value = new Set();
    await settle();
    expect(router.currentRoute.value.query.closed).toBeUndefined();
    expect([...closed.value]).toEqual([]);

    await router.replace({ path: "/page", query: { closed: "7,3" } });
    await settle();
    expect([...closed.value].sort()).toEqual([3, 7]);
    stop();
  });
});
