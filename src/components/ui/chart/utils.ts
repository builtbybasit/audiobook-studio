import type { ChartConfig } from ".";
import { isClient } from "@vueuse/core";
import { h, render } from "vue";

const cache = new Map<string, string>();

function serializeKey(key: Record<string, any>): string {
  return JSON.stringify(key, Object.keys(key).sort());
}

interface Constructor<P = any> {
  __isFragment?: never;
  __isTeleport?: never;
  __isSuspense?: never;
  new (...args: any[]): {
    $props: P;
  };
}

/** One cache namespace per template. A plain counter (upstream uses reka's instance id) lets a
 *  chart rebuild its template when its series change, instead of serving a stale tooltip. */
let nextTemplateId = 0;

export function componentToString<P>(config: ChartConfig, component: Constructor<P>, props?: P) {
  if (!isClient) return;

  const id = `tooltip-${nextTemplateId++}`;

  // https://unovis.dev/docs/auxiliary/Crosshair#component-props
  return (_data: any, x: number | Date) => {
    const data = "data" in _data ? _data.data : _data;
    const serializedKey = `${id}-${serializeKey(data)}`;
    const cachedContent = cache.get(serializedKey);
    if (cachedContent) return cachedContent;

    const vnode = h<unknown>(component, { ...props, payload: data, config, x });
    const div = document.createElement("div");
    render(vnode, div);
    cache.set(serializedKey, div.innerHTML);
    return div.innerHTML;
  };
}
