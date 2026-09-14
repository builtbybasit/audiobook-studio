// The `cn` helper every shadcn-vue component imports: clsx for conditionals, twMerge so a class
// passed in from a call site wins over the component's own default for the same utility.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
