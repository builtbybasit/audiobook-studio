/** Live tests use the endpoint's usual default unless an explicit parallelism is requested. */
export function liveScriptingConcurrency(
  env: Record<string, string | undefined> = process.env,
  fallback = 4,
): number {
  const value = env.SCRIPTING_PROVIDER_CONCURRENCY?.trim();
  if (!value) return fallback;
  const concurrency = Number(value);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error("SCRIPTING_PROVIDER_CONCURRENCY must be a positive whole number");
  return concurrency;
}
