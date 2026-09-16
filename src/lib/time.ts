/** A rounded playback position. Round the whole value first so 179.8s becomes 3:00, never 2:60. */
export function clockDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** A rounded duration below one hour, written for summaries rather than a player. */
export function minuteDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}
