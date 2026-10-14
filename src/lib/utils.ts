// The `cn` helper every shadcn-vue component imports: clsx for conditionals, twMerge so a class
// passed in from a call site wins over the component's own default for the same utility.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Everything the store holds is plain JSON (no dates, maps or functions), so this is correct. */
export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
