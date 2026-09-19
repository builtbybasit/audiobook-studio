// The GFM plugin ships no types, and its whole surface is one function.
//
// Declared here rather than pulled from DefinitelyTyped, which has no entry for the maintained
// Joplin fork. `gfm` is the bundle of the four rules — tables, strikethrough, task lists and
// fenced code — applied to a Turndown instance by `service.use(gfm)`.
declare module "@joplin/turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
  export const highlightedCodeBlock: TurndownService.Plugin;
}
