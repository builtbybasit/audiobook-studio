// Domain model for the prototype, split by feature. The mock world in `src/mock` builds these
// shapes and the store mutates them in place; nothing here is persisted or fetched.
//
// This barrel is the only import path the app uses — `@/types` — so a type can move between the
// files below without touching a single consumer.
export type * from "@/types/common";
export type * from "@/types/voice";
export type * from "@/types/expression";
export type * from "@/types/endpoint";
export type * from "@/types/segment";
export type * from "@/types/book";
export type * from "@/types/job";
export type * from "@/types/scripting";
export type * from "@/types/history";
export type * from "@/types/narration";
export type * from "@/types/export";
export type * from "@/types/bulk";
export type * from "@/types/ui";
export type * from "@/types/demo";
export type * from "@/types/world";
