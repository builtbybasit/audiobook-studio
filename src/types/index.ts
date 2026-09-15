// Domain model for the prototype, split by feature. The mock world in `src/mock` builds these
// shapes and the store mutates them in place; nothing here is persisted or fetched.
//
// This barrel is the only import path the app uses — `@/types` — so a type can move between the
// files below without touching a single consumer.
export type * from "./common";
export type * from "./voice";
export type * from "./expression";
export type * from "./endpoint";
export type * from "./segment";
export type * from "./book";
export type * from "./job";
export type * from "./scripting";
export type * from "./narration";
export type * from "./export";
export type * from "./bulk";
export type * from "./ui";
export type * from "./demo";
export type * from "./world";
