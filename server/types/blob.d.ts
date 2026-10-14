// `Blob.slice` exists at runtime, but Bun's global `Blob` type leaves it out (`Bun.file` has it).
interface Blob {
  slice(start?: number, end?: number, contentType?: string): Blob;
}
