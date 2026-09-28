// `Blob.slice`, which every Blob has at runtime and Bun's global `Blob` type leaves out.
//
// Only `Bun.file`'s own type declares it, so a file a form hands back cannot be sliced without a
// cast — and a slice is how the start of an upload is read without reading all of it, and how it
// is passed on under another type without a copy.
interface Blob {
  slice(start?: number, end?: number, contentType?: string): Blob;
}
