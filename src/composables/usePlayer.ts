// The app's one audio player. A chapter is a timeline: clips with stitched silence (`pauseAfter`)
// between them, from several endpoints. No player library models that, so the queue, gaps and
// playhead are ours and <audio> is only the sound source. Module scope on purpose: playback must
// survive navigation. A clip without a `url` is timed rather than heard: same timeline, silent.
import { effectScope, reactive } from "vue";
import { useMediaControls } from "@vueuse/core";

/** One thing to play: a segment's clip, a take, a finished export. */
export interface Clip {
  /** stable within the queue: a line's `clipOf` (`@/composables/useChapterQueue`) */
  id: string;
  /** seconds; the timeline is drawn from it even with no file behind it */
  duration: number;
  /** silence stitched after this clip, seconds. Never rendered, never billed. */
  gap?: number;
  url?: string;
  /** shown in the mini player and on the OS lock screen */
  label?: string;
  speaker?: string;
}

export interface Queue {
  /** what is playing, as the views name it: a chapter, one line's clip, `exp7` */
  id: string;
  clips: Clip[];
  title?: string;
  subtitle?: string;
  /** Where the mini player links back to. A queue with an href follows you off the page; a bare
   *  audition does not. */
  href?: string;
  /** what to play when this one runs out (usually the next chapter, which may need reading); null to stop */
  next?: () => Queue | null | Promise<Queue | null>;
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
  /** the clip played over and over, or null */
  repeat: string | null;
  /** stop when this queue runs out rather than going on into `next()` */
  stopAtEnd: boolean;
}

const TICK = 100;
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
  repeat: null,
  stopAtEnd: false,
});

const el = typeof Audio === "undefined" ? null : new Audio();
if (el) el.preload = "auto";
// One long-lived scope for the element's listeners: the player outlives every component, so there
// is nothing to dispose.
const scope = effectScope(true);
const media = scope.run(() => useMediaControls(el))!;
// A warm cache only: the next clip's file loads while the current one plays.
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

/** Point the element at the playhead. The only place `el.src` is set. */
function sync(): void {
  const e = entryAt(p.pos);
  const clip = e && p.pos < e.end ? e.clip : null; // null = we are in the silence after a clip
  p.clipId = clip?.id ?? null;
  if (!el) return;
  if (!clip?.url) {
    // silence, or a clip with no file: the tick is the clock
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
    // the element is the clock while a file plays, so a throttled background tab can't desync.
    // Its own duration wins over our metadata.
    p.pos = Math.min(before.start + media.currentTime.value, before.end);
    p.loading = media.waiting.value;
  } else {
    p.pos += dt * p.rate; // a timed clip, or the silence after one
  }
  // a repeated line goes back to its start as the playhead leaves it, before any silence after it
  if (p.repeat && before && before.clip.id === p.repeat && p.pos >= before.end) {
    p.pos = before.start;
    return sync();
  }
  if (p.pos >= p.len) return finish();
  // crossing a boundary: into the next clip, or into this one's trailing silence
  const after = entryAt(p.pos);
  const nowInClip = !!after && p.pos < after.end;
  if (after !== before || nowInClip !== !!inClip) sync();
}

/** the queue ran out: continue into whatever comes next, or stop at the end */
function finish(): void {
  const next = p.stopAtEnd ? null : (queue.next?.() ?? null);
  p.pos = p.len;
  if (!(next instanceof Promise)) return next ? load(next, 0, true) : end();
  // the clock holds while the next chapter is read, so this runs once
  const from = queue;
  clearInterval(timer);
  p.loading = true;
  void next
    .catch(() => null)
    .then((q) => {
      // paused, or another queue started, meanwhile: that wins
      if (queue !== from || !p.playing) return;
      if (q) load(q, 0, true);
      else end();
    });
}

function end(): void {
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
  p.repeat = null; // the repeated line was in the old queue
  loaded = null; // a new queue may reuse a clip id with a different file
  if (autoplay) setPlaying(true);
  sync();
}

// ---------- OS media keys and the lock screen ----------
// Reviews often run with the window in the background. Neither works without real audio.
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

const sameClip = (a: Clip, b: Clip): boolean =>
  a.id === b.id && a.duration === b.duration && (a.gap ?? 0) === (b.gap ?? 0) && a.url === b.url;

/**
 * The queue already loaded under this id, brought up to date: a chapter's timeline moves as its
 * clips land or change, and a seek must land in the new one. The playhead and play state stay.
 */
function refresh(q: Queue): void {
  const same =
    q.clips.length === queue.clips.length && q.clips.every((c, i) => sameClip(c, queue.clips[i]));
  if (same) {
    queue = q;
    p.title = q.title ?? "";
    p.subtitle = q.subtitle ?? "";
    p.href = q.href ?? null;
    return;
  }
  const { pos, repeat } = p;
  load(q, pos);
  if (repeat && q.clips.some((c) => c.id === repeat)) p.repeat = repeat;
}

/** Play a timeline, from `at` if given. Pressing the same queue again with no `at` toggles. */
function playQueue(q: Queue, at?: number): void {
  if (p.id !== q.id) return load(q, at ?? 0, true);
  refresh(q);
  if (at != null) {
    seekTo(at);
    if (!p.playing) resume();
    return;
  }
  if (p.playing) return pause();
  if (p.pos >= p.len) p.pos = 0;
  resume();
}

/** Load a timeline and park the playhead without starting (or stopping) it. */
function cue(q: Queue, at = 0): void {
  if (p.id !== q.id) return load(q, at, false);
  refresh(q);
  seekTo(at);
}

/** One clip, by id. */
function play(id: string, len: number, url?: string, title = id): void {
  playQueue({ id, clips: [{ id, duration: len, url }], title });
}

/** A file of unknown length (a provider's voice sample), timed from its metadata. Toggles. */
async function playFile(id: string, url: string, title = id): Promise<void> {
  const duration = p.id === id ? p.len : await fileDuration(url);
  playQueue({ id, clips: [{ id, duration, url }], title });
}

function fileDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = new Audio();
    probe.preload = "metadata";
    probe.onloadedmetadata = () =>
      Number.isFinite(probe.duration) && probe.duration > 0
        ? resolve(probe.duration)
        : reject(new Error("The file does not say how long it plays"));
    probe.onerror = () => reject(new Error("The file could not be loaded"));
    probe.src = url;
  });
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
  // seeking away from the repeated line ends the repeat
  if (p.repeat && entryAt(p.pos)?.clip.id !== p.repeat) p.repeat = null;
  sync();
}
/** 0…1 of the queue, as a scrubber click gives */
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
/** How far through one clip the playhead is, 0…1; null when that clip is not playing. */
function clipProgress(id: string): number | null {
  const e = layout.find((x) => x.clip.id === id);
  if (!e || p.pos < e.start || p.pos > e.end) return null;
  return e.end > e.start ? (p.pos - e.start) / (e.end - e.start) : 0;
}

/**
 * The playhead now, for word-level views: `p.pos` ticks 10×/s and `currentTime` a few times a
 * second, both coarser than a word, so this reads the element's clock while a file plays.
 */
function now(): number {
  const e = entryAt(p.pos);
  if (!p.playing || !e || p.pos >= e.end || !e.clip.url || !el || el.paused) return p.pos;
  return Math.min(e.start + el.currentTime, e.end);
}

/** Play one clip over and over, by id, or null to stop. */
function repeatClip(id: string | null): void {
  p.repeat = id;
}
function setStopAtEnd(v: boolean): void {
  p.stopAtEnd = v;
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
  playFile,
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
  repeatClip,
  setStopAtEnd,
  clipProgress,
  now,
  /** the queue's clips, for a view that wants to draw them */
  layout: () => layout,
};

/** Always the same player. */
export function usePlayer(): typeof api {
  return api;
}
