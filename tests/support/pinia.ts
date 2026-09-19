// A Pinia to test stores against, with the query cache the app installs.
//
// Reads are queries (`src/queries/`), and the query cache is a Pinia store of its own that the
// `PiniaColada` plugin installs on an app. A store that invalidates a query — the jobs store after
// a cancel, the library store after a renumbering — reaches for that cache, so a test of one needs
// the plugin installed the way `main.ts` installs it. An app is created and never mounted: nothing
// here needs a DOM, and `runWithContext` is what gives `useQuery` and `useQueryCache` the injection
// context they resolve their defaults through.
import { createApp, effectScope, type App, type EffectScope } from "vue";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { PiniaColada } from "@pinia/colada";

export interface TestPinia {
  pinia: Pinia;
  app: App;
  /** Run `fn` where `useQuery` and `useQueryCache` can be called, inside one effect scope. */
  run<T>(fn: () => T): T;
  /** Stop every query started through `run`. */
  stop(): void;
}

export function testPinia(): TestPinia {
  const pinia = createPinia();
  const app = createApp({})
    .use(pinia)
    .use(PiniaColada, {
      // no timers the suite would have to wait out: nothing is collected, nothing re-reads on focus
      queryOptions: { gcTime: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
    });
  setActivePinia(pinia);
  const scopes: EffectScope[] = [];
  return {
    pinia,
    app,
    run<T>(fn: () => T): T {
      const scope = effectScope();
      scopes.push(scope);
      return app.runWithContext(() => scope.run(fn) as T);
    },
    stop() {
      for (const scope of scopes) scope.stop();
      scopes.length = 0;
    },
  };
}

/** Let a query settle: one turn for the read, one for what it installs. */
export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
