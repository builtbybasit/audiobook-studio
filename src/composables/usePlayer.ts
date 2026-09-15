// The app's one audio player.
//
// A file is not the unit of playback here. A chapter is a *timeline*: clips with stitched silence
// between them (`pauseAfter`), each clip rendered by whichever endpoint owns its speaker's voice. No
// player library models that, so the queue, the gaps and the playhead are ours and the <audio>
// element is only the sound source. Reactive media state comes from VueUse's `useMediaControls`,
// which is already a dependency.
//
// It lives at module scope on purpose. Reviewing a book means listening while editing the script,
// the cast or the dictionary, and a player owned by a view stops the moment you navigate away.
//
// A clip carries a `url` when a backend has audio to serve. The prototype has none, so a clip
// without one is *timed* rather than heard: same timeline, same scrubber, same gaps, silent. That is
// also the seam — give clips urls and the same code plays them.
import { effectScope, reactive } from "vue";
import { useMediaControls } from "@vueuse/core";

/** One thing to play: a segment's clip, a take, a finished export. */
export interface Clip {
  /** stable within the queue — the ledger's `seg42`, a take's `seg42#2` */
  id: string;
  /** seconds. What the timeline is drawn from, even when there is no file behind it. */
  duration: number;
  /** silence stitched after this clip, seconds. Never rendered, never billed. */
  gap?: number;
  /** real audio, when there is any */
  url?: string;
  /** shown in the mini player and on the OS lock screen */
  label?: string;
  speaker?: string;
}

export interface Queue {
  /** what is playing, as the views name it: `chapter`, `seg42`, `exp7` */
  id: string;
  clips: Clip[];
  title?: string;
  subtitle?: string;
  /** Where the mini player takes you back to — and the mark of long-form playback: a queue with an
   *  href follows you off the page, a bare audition (one clip, a few seconds) does not. */
  href?: string;
  /** what to play when this one runs out — the next chapter, usually. Return null to stop. */
  next?: () => Queue | null;
}

export interface PlayerState {
  /** the queue's id; the views compare against it to light their own play buttons */
  id: string | null;
  /** seconds into the whole queue, silence included */
  pos: number;
  /** the queue's total length, silence included */
  len: number;
  playing: boolean;
  rate: number;
  /** the clip under the playhead; null while it is in the silence between two */
  clipId: string | null;
  /** a real file is still buffering */
  loading: boolean;
  /** clips in this queue that have a file. 0 = a timed, silent run. */
  live: number;
  title: string;
  subtitle: string;
  href: string | null;
}

const TICK = 100;
/** the speeds an audiobook is actually reviewed at */
export const RATES = [1, 1.25, 1.5, 1.75, 2] as const;

const p = reactive<PlayerState>({
  id: null,
  pos: 0,
  len: 0,
  playing: false,
  rate: 1,
  clipId: null,
  loading: false,
  live: 0,
  title: "",
  subtitle: "",
  href: null,
});

const el = typeof Audio === "undefined" ? null : new Audio();
if (el) el.preload = "auto";
// One long-lived scope for the element's listeners: this player outlives every component that talks
// to it, so there is deliberately nothing to dispose.
const scope = effectScope(true);
const media = scope.run(() => useMediaControls(el))!;
// The second element is only ever a warm cache: the next clip's file is fetched while the current
// one plays, so the handoff isn't a network round trip.
const ahead = typeof Audio === "undefined" ? null : new Audio();
if (ahead) ahead.preload = "auto";

let queue: Queue = { id: "", clips: [] };
/** clip bounds in queue time; `until` includes the silence after it */
let layout: { clip: Clip; start: number; end: number; until: number }[] = [];
let loaded: string | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let last = 0;

function relayout(): void {
  let t = 0;
  layout = queue.clips.map((clip) => {
    const start = t;
    const end = start + Math.max(0, clip.duration || 0);
    t = end + Math.max(0, clip.gap ?? 0);
    return { clip, start, end, until: t };
  });
  p.len = t;
  p.live = queue.clips.filter((c) => c.url).length;
}

const entryAt = (pos: number) => layout.find((e) => pos < e.until) ?? layout.at(-1) ?? null;
const indexAt = (pos: number) => {
  const e = entryAt(pos);
  return e ? layout.indexOf(e) : -1;
};

/** Point the element at wherever the playhead is now. The only place `el.src` is ever set. */
function sync(): void {
  const e = entryAt(p.pos);
  const clip = e && p.pos < e.end ? e.clip : null; // null = we are in the silence after a clip
  p.clipId = clip?.id ?? null;
  if (!el) return;
  if (!clip?.url) {
    // silence, or a clip with no file — the tick is the clock and the element has nothing to do
    if (!el.paused) el.pause();
    p.loading = false;
    return;
  }
  if (loaded !== clip.url) {
    loaded = clip.url;
    el.src = clip.url;
    p.loading = true;
  }
  const into = p.pos - e!.start;
  if (Math.abs(media.currentTime.value - into) > 0.25) media.currentTime.value = into;
  media.rate.value = p.rate;
  if (p.playing && el.paused) void el.play().catch(() => {});
  if (!p.playing && !el.paused) el.pause();
  warm(indexAt(p.pos) + 1);
  announce(clip);
}

/** fetch the next file while this one plays */
function warm(i: number): void {
  const url = layout[i]?.clip.url;
  if (ahead && url && ahead.src !== url) ahead.src = url;
}

function tick(): void {
  if (!p.playing) return;
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  const before = entryAt(p.pos);
  const inClip = before && p.pos < before.end;
  if (inClip && before.clip.url && el && !el.paused) {
    // the element is the clock while a real file plays, so a throttled background tab can't desync
    // the audio from the playhead. Its own duration wins over our metadata if the two disagree.
    p.pos = Math.min(before.start + media.currentTime.value, before.end);
    p.loading = media.waiting.value;
  } else {
    p.pos += dt * p.rate; // a timed clip, or the silence after one
  }
  if (p.pos >= p.len) return finish();
  // crossing a boundary — into the next clip, or off the end of this one into its silence
  const after = entryAt(p.pos);
  const nowInClip = !!after && p.pos < after.end;
  if (after !== before || nowInClip !== !!inClip) sync();
}

/** the queue ran out: continue into whatever comes next, or stop at the end */
function finish(): void {
  const next = queue.next?.() ?? null;
  if (next) return load(next, 0, true);
  p.pos = p.len;
  setPlaying(false);
  sync();
}

function setPlaying(v: boolean): void {
  p.playing = v;
  clearInterval(timer);
  if (v) {
    last = performance.now();
    timer = setInterval(tick, TICK);
  } else if (el && !el.paused) el.pause();
  announce(entryAt(p.pos)?.clip);
}

function load(q: Queue, at = 0, autoplay = false): void {
  queue = q;
  relayout();
  p.id = q.id;
  p.title = q.title ?? "";
  p.subtitle = q.subtitle ?? "";
  p.href = q.href ?? null;
  p.pos = Math.min(Math.max(0, at), Math.max(0, p.len));
  loaded = null; // a new queue may reuse a clip id with a different file
  if (autoplay) setPlaying(true);
  sync();
}

// ---------- OS media keys and the lock screen ----------
// An audiobook is reviewed with the window in the background as often as not, so hardware keys and
// the lock-screen card matter. Both are free; neither exists without real audio behind them.
function announce(clip?: Clip | null): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.playbackState = p.playing ? "playing" : "paused";
    if (!clip) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: clip.label ?? p.title,
      artist: clip.speaker ?? p.subtitle,
      album: p.title,
    });
  } catch {}
}
if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
  const set = (k: MediaSessionAction, fn: () => void) => {
    try {
      navigator.mediaSession.setActionHandler(k, fn);
    } catch {}
  };
  set("play", () => resume());
  set("pause", () => pause());
  set("seekbackward", () => skip(-10));
  set("seekforward", () => skip(10));
  set("previoustrack", () => prev());
  set("nexttrack", () => next());
}

// ---------- the API the views use ----------

/** Play a timeline. Pressing the same queue again toggles, as every play button in the app expects. */
function playQueue(q: Queue, at?: number): void {
  if (p.id === q.id && at == null) {
    if (p.playing) return pause();
    if (p.pos >= p.len) p.pos = 0;
    return resume();
  }
  load(q, at ?? 0, true);
}

/** Load a timeline and park the playhead in it without starting — scrubbing before pressing play. */
function cue(q: Queue, at = 0): void {
  load(q, at, false);
}

/** One clip, by id — the shape the ledger's per-row and the export list's buttons already use. */
function play(id: string, len: number, url?: string): void {
  playQueue({ id, clips: [{ id, duration: len, url }], title: id });
}

function pause(): void {
  setPlaying(false);
}
function resume(): void {
  if (!p.len) return;
  setPlaying(true);
  sync();
}
function toggle(): void {
  if (p.playing) pause();
  else resume();
}
function stop(): void {
  setPlaying(false);
  load({ id: "", clips: [] });
  p.id = null;
}

/** seconds into the queue */
function seekTo(sec: number): void {
  p.pos = Math.min(Math.max(0, sec), p.len);
  sync();
}
/** 0…1 of the queue — what a click on the scrubber gives */
function seek(frac: number): void {
  seekTo(frac * p.len);
}
function skip(delta: number): void {
  seekTo(p.pos + delta);
}
/** start of the next clip */
function next(): void {
  const i = indexAt(p.pos);
  if (i >= 0 && i + 1 < layout.length) seekTo(layout[i + 1].start);
  else finish();
}
/** start of this clip, or the one before it if we only just started this one */
function prev(): void {
  const i = indexAt(p.pos);
  if (i < 0) return;
  const e = layout[i];
  seekTo(p.pos - e.start < 2 && i > 0 ? layout[i - 1].start : e.start);
}
/**
 * How far through one clip the playhead is, 0…1 — or null when that clip is not the one playing.
 * A view can ask about any clip it drew (a take, a candidate, a line of the chapter) without
 * knowing where in the queue it sits.
 */
function clipProgress(id: string): number | null {
  const e = layout.find((x) => x.clip.id === id);
  if (!e || p.pos < e.start || p.pos > e.end) return null;
  return e.end > e.start ? (p.pos - e.start) / (e.end - e.start) : 0;
}

function setRate(r: number): void {
  p.rate = r;
  media.rate.value = r;
}
function cycleRate(): void {
  setRate(RATES[(RATES.indexOf(p.rate as (typeof RATES)[number]) + 1) % RATES.length] ?? 1);
}

const api = {
  p,
  play,
  playQueue,
  cue,
  pause,
  resume,
  toggle,
  stop,
  seek,
  seekTo,
  skip,
  next,
  prev,
  setRate,
  cycleRate,
  clipProgress,
  /** the queue's clips, for a view that wants to draw them */
  layout: () => layout,
};

/** Always the same player — there is only one pair of ears. */
export function usePlayer(): typeof api {
  return api;
}

export function speak(text: string, voice: string): void {
  // Voice preview: real audio via the browser's own TTS so the button does *something*.
  try {
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    if (voices.length) u.voice = voices[Math.abs(hash(voice)) % voices.length];
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}
function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}
