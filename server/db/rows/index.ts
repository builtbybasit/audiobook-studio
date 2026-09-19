// Rows in, domain shapes out.
//
// Everything above this directory works in the shapes `@/types` defines; everything below works in
// columns. Keeping the translation here is what lets the schema gain a column without the routes,
// the import or the tests noticing — and what makes "does the schema actually hold the domain" a
// question the test suite can answer, by writing a real world through these and reading it back.
export * from "~/db/rows/library";
export * from "~/db/rows/cast";
export * from "~/db/rows/script";
export * from "~/db/rows/endpoints";
export * from "~/db/rows/exports";
export * from "~/db/rows/jobs";
export * from "~/db/rows/usage";
