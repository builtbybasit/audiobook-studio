// PROTOTYPE — in-memory state + simulated jobs. Nothing persists.
import { defineStore } from 'pinia'
import { makeWorld, generateSegments, PALETTE, DISCOVERABLE_VOICES, voiceRef } from '../mock/data'
import { splitText, partsFor } from '../lib/split'
import { keyring } from '../lib/keyring'
export { keyring }
const clone = (x) => JSON.parse(JSON.stringify(x))
const AVG_JOB = { scripting: 25, narration: 60, export: 120 }   // seconds, until we have history
const ERRORS = [
  { code: 500, message: 'server error', body: '{"error":{"message":"The server had an error while processing your request.","type":"server_error"}}' },
  { code: 502, message: 'bad gateway', body: '<html><body><h1>502 Bad Gateway</h1></body></html>' },
  { code: 400, message: 'invalid voice', body: '{"error":{"message":"voice is not a valid voice for this model","param":"voice"}}' },
]

let jobSeq = 100
export const isScripted = (c) => c.scripting === 'done' || c.scripting === 'fallback'
export const isNarrated = (c) => c.narration === 'done' || c.narration === 'stale'
export const norm = (n) => n.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
export { voiceRef }
export { partsFor }
const GENDER = { m: 'male', f: 'female', n: 'neutral' }
const ago = (min) => Date.now() - min * 60000
function collapseChunk(segs) {
  const start = 4 + Math.floor(Math.random() * Math.max(1, segs.length - 12)), n = 5 + Math.floor(Math.random() * 4)
  const run = segs.slice(start, start + n)
  const merged = { id: 0, type: 'narration', speaker: 'Narrator', text: run.map(x => x.type === 'dialogue' ? `“${x.text}”` : x.text).join(' '), direction: '', fallback: true, fallbackCount: n, fallbackMismatch: run[Math.floor(n / 2)].text.slice(0, 40), audio: { status: 'none', endpoint: null, ms: 0, duration: 0 } }
  const out = [...segs.slice(0, start), merged, ...segs.slice(start + n)]
  out.forEach((x, i) => x.id = i + 1)
  return out
}
// History from "earlier today" so the Queue page has done / failed / cancelled rows to act on.
function seedJobs() {
  const mk = (kind, bookId, chapterId, label, status, startMin, secs) => ({ id: jobSeq++, kind, bookId, chapterId, label, status, progress: status === 'done' ? 100 : status === 'failed' ? 100 : 40, queuedAt: ago(startMin + 1), startedAt: ago(startMin), finishedAt: ago(startMin) + secs * 1000, cancelled: status === 'cancelled' })
  return [
    mk('export', 'starforge', null, 'Build M4B · 18 ch', 'done', 95, 214),
    mk('narration', 'starforge', 18, 'Narrate · ch 18', 'done', 118, 71),
    mk('narration', 'starforge', 17, 'Narrate · ch 17', 'done', 121, 64),
    mk('scripting', 'cliche', 12, 'Script · ch 12', 'done', 41, 26),
    mk('scripting', 'cliche', 11, 'Script · ch 11', 'done', 42, 24),
    mk('narration', 'cliche', 4, 'Narrate · ch 4', 'failed', 33, 58),
    mk('narration', 'cliche', 3, 'Narrate · ch 3', 'done', 35, 61),
    mk('scripting', 'drowned', 2, 'Script · ch 2', 'failed', 12, 31),
    mk('scripting', 'drowned', 1, 'Script · ch 1', 'done', 13, 27),
    mk('narration', 'drowned', 1, 'Narrate · ch 1', 'cancelled', 9, 12),
  ]
}
const key = (b, c) => `${b}:${c}`
// simulate a re-run of the LLM: same prose, but ~10% of dialogue re-attributed and one narration pair merged
function reseg(segs) {
  const speakers = [...new Set(segs.filter(x => x.type === 'dialogue').map(x => x.speaker))]
  const out = segs.map(x => ({ ...x }))
  out.forEach((x, i) => { if (x.type === 'dialogue' && speakers.length > 1 && i % 9 === 3) x.speaker = speakers[(speakers.indexOf(x.speaker) + 1) % speakers.length] })
  const i = out.findIndex((x, k) => x.type === 'narration' && out[k + 1]?.type === 'narration')
  if (i >= 0) { out[i].text = out[i].text + ' ' + out[i + 1].text; out.splice(i + 1, 1) }
  out.forEach((x, k) => { x.id = k + 1; x.audio = { status: 'none', endpoint: null, ms: 0, duration: 0 } })
  return out
}
const rnd = (a, b) => a + Math.random() * (b - a)

export const useApp = defineStore('app', {
  state: () => ({
    ...makeWorld(),
    profiles: [
      { id: 'openai', name: 'OpenAI', model: 'gpt-4o-mini', inPrice: 0.15, outPrice: 0.6, secPerChunk: 9, needsKey: true },
      { id: 'deepseek', name: 'DeepSeek', model: 'deepseek-chat', inPrice: 0.14, outPrice: 0.28, secPerChunk: 14, needsKey: true },
      { id: 'antigravity', name: 'Antigravity (local)', model: 'gemini-3.6-flash-low', inPrice: 0, outPrice: 0, secPerChunk: 25, needsKey: false },
    ],
    scriptSettings: { profile: 'openai', chunkChars: 6000, stripWatermarks: true },
    jobs: seedJobs(),
    toasts: [],
    _undo: [],            // most recent last; each { label, revert }
    _previous: {},        // `${bookId}:${chId}` → segments before the last re-script (for the diff panel)
    notify: false,        // browser notifications when a book's run finishes
    _kicked: false,
    dark: window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true,
    currentBookId: null,
  }),

  getters: {
    book: (s) => s.books.find(b => b.id === s.currentBookId),
    bookById: (s) => (id) => s.books.find(b => b.id === id),
    chaptersOf: (s) => (id) => s.chapters[id] ?? [],
    chapter: (s) => (bookId, chId) => (s.chapters[bookId] ?? []).find(c => c.id === chId),
    charactersOf: (s) => (id) => s.characters[id] ?? [],
    volumesOf: (s) => (id) => s.books.find(b => b.id === id)?.volumes ?? [],
    volumeOf: (s) => (bookId, chId) => { const c = (s.chapters[bookId] ?? []).find(c => c.id === chId); return s.books.find(b => b.id === bookId)?.volumes.find(v => v.id === c?.volumeId) },
    segmentsOf: (s) => (bookId, chId) => s.segments[key(bookId, chId)] ?? [],
    progress: (s) => (id) => {
      const all = s.chapters[id] ?? []
      const ch = all.filter(c => !c.excluded)
      return {
        total: ch.length, excluded: all.length - ch.length,
        scripted: ch.filter(isScripted).length,
        fallback: ch.filter(c => c.scripting === 'fallback').length,
        narrated: ch.filter(isNarrated).length,
        stale: ch.filter(c => c.narration === 'stale').length,
        exported: s.exports.filter(e => e.bookId === id && e.status === 'done').length,
        running: ch.some(c => c.scripting === 'running' || c.narration === 'running'),
      }
    },
    activeJobs: (s) => s.jobs.filter(j => j.status === 'running' || j.status === 'queued'),
    endpointLoad: (s) => {
      const load = Object.fromEntries(s.endpoints.map(e => [e.id, { active: 0, done: 0, failed: 0, backoff: e.backoffUntil > Date.now() }]))
      for (const segs of Object.values(s.segments)) for (const seg of segs) {
        const l = load[seg.audio.endpoint]; if (!l) continue
        if (seg.audio.status === 'generating') l.active++
        else if (seg.audio.status === 'done') l.done++
        else if (seg.audio.status === 'failed') l.failed++
      }
      return load
    },
    recentJobs: (s) => [...s.jobs].reverse().slice(0, 12),
    enabledEndpoints: (s) => s.endpoints.filter(e => e.enabled),
    // voice ref `<endpointId>/<voiceId>` → { endpoint, voice } or null when either side was removed
    resolveVoice: (s) => (ref) => {
      if (!ref) return null
      const i = ref.indexOf('/')
      const ep = s.endpoints.find(e => e.id === ref.slice(0, i))
      const v = ep?.voices.find(v => v.id === ref.slice(i + 1))
      return ep && v ? { endpoint: ep, voice: v } : null
    },
    voiceLabel() { return (ref) => { const r = this.resolveVoice(ref); return r ? `${r.voice.label} · ${r.endpoint.name}` : ref ? `${ref.split('/')[1]} (missing)` : '' } },
    // every voice on every endpoint, grouped for the pickers; paused endpoints stay listed but disabled
    voiceOptions: (s) => s.endpoints.flatMap(e => e.voices.map(v => ({
      value: voiceRef(e.id, v.id), label: v.label, group: e.enabled ? e.name : `${e.name} · paused`, hint: GENDER[v.gender] ?? '', disabled: !e.enabled,
    }))),
    // a character with no voice of their own is read in the Narrator's voice
    effectiveVoice() { return (bookId, name) => {
      const cast = this.characters[bookId] ?? []
      const c = cast.find(x => x.name === name)
      const ref = c?.voice || cast.find(x => x.name === 'Narrator')?.voice || null
      const r = this.resolveVoice(ref)
      return { ref, own: !!c?.voice, voice: r?.voice.id ?? null, label: r ? r.voice.label : ref ? 'missing' : null, endpoint: r?.endpoint ?? null }
    } },
    // speakers whose voice can't be rendered right now: voice/endpoint gone, endpoint paused, key missing
    routingIssues() { return (bookId) => {
      const out = []
      for (const c of this.characters[bookId] ?? []) {
        if (!c.voice) continue
        const r = this.resolveVoice(c.voice)
        if (!r) out.push({ name: c.name, ref: c.voice, reason: 'voice no longer exists', kind: 'missing' })
        else if (!r.endpoint.enabled) out.push({ name: c.name, ref: c.voice, reason: `${r.endpoint.name} is paused`, kind: 'paused', endpoint: r.endpoint })
        else if (r.endpoint.needsKey && !keyring.has(r.endpoint.id)) out.push({ name: c.name, ref: c.voice, reason: `${r.endpoint.name} has no API key`, kind: 'nokey', endpoint: r.endpoint })
      }
      return out
    } },
    scriptEstimate: (s) => (bookId, ids) => {
      const chs = (s.chapters[bookId] ?? []).filter(c => ids.includes(c.id))
      const chars = chs.reduce((a, c) => a + c.words * 5.6, 0)
      const chunks = chs.reduce((a, c) => a + Math.ceil(c.words * 5.6 / s.scriptSettings.chunkChars), 0)
      const p = s.profiles.find(p => p.id === s.scriptSettings.profile)
      const inTok = chars / 4 * 1.6, outTok = chars / 4 * 1.15   // prompt + context carry-over; re-emitted text + labels
      return { chapters: chs.length, chars, chunks, seconds: chunks * (p?.secPerChunk ?? 10), cost: (inTok * (p?.inPrice ?? 0) + outTok * (p?.outPrice ?? 0)) / 1e6, profile: p }
    },
    // raw chapter text (mock: rebuilt from the generator) for the picker's peek
    rawText: () => (bookId, chId) => generateSegments(bookId, chId).map(x => x.text).join('\n\n'),
    // what the last re-script changed, by matching segments on text
    scriptDiff: (s) => (bookId, chId) => {
      const prev = s._previous[key(bookId, chId)]; if (!prev) return null
      const cur = s.segments[key(bookId, chId)] ?? []
      const byText = (arr) => { const m = new Map(); for (const x of arr) m.set(x.text, x); return m }
      const pm = byText(prev), cm = byText(cur)
      const speaker = [], direction = []
      for (const [t, c] of cm) { const p = pm.get(t); if (!p) continue; if (p.speaker !== c.speaker) speaker.push({ id: c.id, text: t, from: p.speaker, to: c.speaker }); else if ((p.direction || '') !== (c.direction || '')) direction.push({ id: c.id, text: t, from: p.direction, to: c.direction }) }
      const added = cur.filter(c => !pm.has(c.text)), removed = prev.filter(p => !cm.has(p.text))
      return { speaker, direction, added, removed, total: speaker.length + direction.length + added.length + removed.length, prevCount: prev.length, curCount: cur.length }
    },
    // money already rendered for a book (sum of each clip's recorded cost)
    spent: (s) => (bookId) => { let t = 0; for (const [k, segs] of Object.entries(s.segments)) if (k.startsWith(bookId + ':')) for (const x of segs) if (x.audio.cost && x.audio.status !== 'failed') t += x.audio.cost; return t },
    // rough finish time for everything active: per-book chains run in parallel, so take the longest chain
    eta: (s) => {
      const hist = {}; for (const j of s.jobs) if (j.status === 'done' && j.startedAt && j.finishedAt) (hist[j.kind] ??= []).push((j.finishedAt - j.startedAt) / 1000)
      const avg = (k) => hist[k]?.length ? hist[k].reduce((a, b) => a + b, 0) / hist[k].length : AVG_JOB[k] ?? 60
      const perBook = {}
      for (const j of s.jobs) {
        if (j.status !== 'running' && j.status !== 'queued') continue
        const secs = j.status === 'queued' ? avg(j.kind) : avg(j.kind) * (1 - (j.progress ?? 0) / 100)
        perBook[j.bookId] = (perBook[j.bookId] ?? 0) + secs
      }
      const seconds = Math.max(0, ...Object.values(perBook))
      return Object.keys(perBook).length ? { seconds, at: Date.now() + seconds * 1000, books: Object.keys(perBook).length } : null
    },
    castStats: (s) => (bookId) => {
      const stats = {}
      for (const c of s.chapters[bookId] ?? []) for (const seg of s.segments[`${bookId}:${c.id}`] ?? []) {
        const st = stats[seg.speaker] ??= { lines: 0, chapters: new Set(), first: c.id }
        st.lines++; st.chapters.add(c.id); if (c.id < st.first) st.first = c.id
      }
      return stats
    },
    // near-duplicate names worth merging: alias matches, one name contained in another, shared surname-ish token
    mergeSuggestions: (s) => (bookId) => {
      const cast = s.characters[bookId] ?? []
      const out = []
      for (const a of cast) for (const b of cast) {
        if (a === b || a.name === 'Narrator' || b.name === 'Narrator') continue
        const na = norm(a.name), nb = norm(b.name)
        if (a.major && !b.major && b.aliases.length === 0 && a.aliases.some(x => norm(x) === nb)) out.push({ from: b.name, into: a.name, reason: `“${b.name}” is a known alias of ${a.name}` })
        else if (!b.major && na !== nb && na.split(' ').includes(nb) && nb.length > 2) out.push({ from: b.name, into: a.name, reason: `“${b.name}” looks like a short form of ${a.name}` })
        else if (!b.major && b.isNew && na !== nb && na.includes(nb) && nb.length > 3) out.push({ from: b.name, into: a.name, reason: `“${b.name}” is contained in ${a.name}` })
      }
      const seen = new Set()
      return out.filter(x => { const k = x.from; if (seen.has(k)) return false; seen.add(k); return true })
    },
    // Cost and load are per endpoint: each segment goes to the endpoint that owns its speaker's voice,
    // and a segment longer than that endpoint's limit becomes several requests.
    estimate() { return (bookId, ids) => {
      const per = {}   // endpointId → { endpoint, chars, segments, requests, split }
      let chars = 0, segments = 0, unrouted = 0, stale = 0
      for (const id of ids) for (const seg of this.segments[`${bookId}:${id}`] ?? []) {
        chars += seg.text.length; segments++
        if (seg.audio.status === 'stale') stale++
        const ep = this.effectiveVoice(bookId, seg.speaker).endpoint
        if (!ep) { unrouted++; continue }
        const e = per[ep.id] ??= { endpoint: ep, chars: 0, segments: 0, requests: 0, split: 0 }
        const parts = partsFor(seg.text, ep)
        e.chars += seg.text.length; e.segments++; e.requests += parts; if (parts > 1) e.split++
      }
      const rows = Object.values(per)
      const cost = rows.reduce((a, e) => a + e.chars / 1e6 * e.endpoint.price, 0)
      return { chapters: ids.length, chars, segments, seconds: chars / 15.5, cost, stale, unrouted,
        requests: rows.reduce((a, e) => a + e.requests, 0), split: rows.reduce((a, e) => a + e.split, 0), endpoints: this.endpoints.filter(e => e.enabled).length, per: rows }
    } },
  },

  actions: {
    // ---------- toasts & undo ----------
    toast(msg, { kind = 'info', undo = null, action = null, timeout } = {}) {
      timeout ??= undo ? 10000 : 6000
      const t = { id: Date.now() + Math.random(), msg, kind, undo, action }
      this.toasts.push(t)
      if (undo) this._undo = [...this._undo.slice(-9), { label: msg, revert: undo }]
      if (timeout) setTimeout(() => this.dismissToast(t.id), timeout)
      return t
    },
    dismissToast(id) { this.toasts = this.toasts.filter(t => t.id !== id) },
    undoToast(id) { const t = this.toasts.find(t => t.id === id); if (!t?.undo) return; t.undo(); this._undo = this._undo.filter(u => u.revert !== t.undo); this.dismissToast(id); this.toast('Undone: ' + t.msg, { timeout: 3000 }) },
    undoLast() { const u = this._undo.pop(); if (!u) return false; u.revert(); this.toasts = this.toasts.filter(t => t.undo !== u.revert); this.toast('Undone: ' + u.label, { timeout: 3000 }); return true },
    // snapshots used by undo: the cast + every segment of a book (speakers live in both)
    _castSnapshot(bookId) {
      const chars = clone(this.characters[bookId]); const segs = {}
      for (const [k, v] of Object.entries(this.segments)) if (k.startsWith(bookId + ':')) segs[k] = clone(v)
      return () => { this.characters[bookId] = chars; for (const [k, v] of Object.entries(segs)) this.segments[k] = v }
    },
    _bookSnapshot(bookId) {
      const i = this.books.findIndex(b => b.id === bookId)
      const book = clone(this.books[i]), chapters = clone(this.chapters[bookId]), chars = clone(this.characters[bookId])
      const segs = {}; for (const [k, v] of Object.entries(this.segments)) if (k.startsWith(bookId + ':')) segs[k] = clone(v)
      const exports = clone(this.exports.filter(e => e.bookId === bookId)), jobs = clone(this.jobs.filter(j => j.bookId === bookId && j.status !== 'running' && j.status !== 'queued'))
      return () => {
        if (!this.books.some(b => b.id === bookId)) this.books.splice(Math.min(i, this.books.length), 0, book); else Object.assign(this.books.find(b => b.id === bookId), book)
        this.chapters[bookId] = chapters; this.characters[bookId] = chars
        this.segments = { ...Object.fromEntries(Object.entries(this.segments).filter(([k]) => !k.startsWith(bookId + ':'))), ...segs }
        this.exports = [...exports, ...this.exports.filter(e => e.bookId !== bookId)]
        this.jobs = [...this.jobs.filter(j => j.bookId !== bookId), ...jobs].sort((a, b) => a.id - b.id)
      }
    },

    // ---------- chapters ----------
    setExcluded(bookId, chId, v) { const c = this.chapter(bookId, chId); if (c) c.excluded = v },
    // apply one direction to every line of a speaker in a chapter (marks rendered ones stale)
    applyDirection(bookId, chId, speaker, direction) {
      let n = 0
      for (const s of this.segmentsOf(bookId, chId)) if (s.speaker === speaker && (s.direction || '') !== direction) { s.direction = direction; s.edited = true; this._markStale(bookId, chId, s); n++ }
      if (n) this.toast(`Direction “${direction}” applied to ${n} ${speaker} line${n === 1 ? '' : 's'}`, { timeout: 3000 })
      return n
    },

    // ---------- budget & pause ----------
    pauseBook(bookId) {
      for (const j of this.jobs) if (j.bookId === bookId && (j.status === 'running' || j.status === 'queued')) this.cancelJob(j.id)
      const b = this.bookById(bookId); if (b) (b.budget ??= { cap: null, paused: false }).paused = true
      this.toast(`${b?.title}: everything paused`, { timeout: 3000 })
    },
    resumeBook(bookId) { const b = this.bookById(bookId); if (b?.budget) b.budget.paused = false },
    setBudgetCap(bookId, cap) { const b = this.bookById(bookId); if (b) (b.budget ??= { cap: null, paused: false }).cap = cap || null },
    _blocked(bookId, kind) {
      const b = this.bookById(bookId)
      if (b?.budget?.paused) { this.toast(`${b.title} is paused — resume it from the overview to ${kind}`, { kind: 'warn' }); return true }
      return false
    },

    // ---------- settings (endpoints & profiles, keys excluded) ----------
    exportSettings() {
      return { version: 1, exportedAt: new Date().toISOString(), endpoints: this.endpoints.map(({ history, failures, rateLimits, backoffUntil, lastError, fetching, ...e }) => e), profiles: this.profiles.map(p => ({ ...p })), scriptSettings: { ...this.scriptSettings } }
    },
    importSettings(obj) {
      if (!obj || !Array.isArray(obj.endpoints)) throw new Error('not a settings file')
      let n = 0
      for (const e of obj.endpoints) { const cur = this.endpoints.find(x => x.id === e.id); const fresh = { history: [], failures: 0, rateLimits: 0, backoffUntil: 0, ...e }; cur ? Object.assign(cur, fresh) : this.endpoints.push(fresh); n++ }
      for (const p of obj.profiles ?? []) { const cur = this.profiles.find(x => x.id === p.id); cur ? Object.assign(cur, p) : this.profiles.push(p) }
      if (obj.scriptSettings) Object.assign(this.scriptSettings, obj.scriptSettings)
      this.toast(`Imported ${n} endpoint${n === 1 ? '' : 's'} — API keys are never in the file, add them again`, { timeout: 6000 })
    },

    // ---------- shared ----------
    addJob(kind, bookId, label, chapterId = null) {
      this.jobs.push({ id: jobSeq++, kind, bookId, chapterId, label, status: 'queued', progress: 0, queuedAt: Date.now(), startedAt: null, finishedAt: null, cancelled: false })
      return this.jobs[this.jobs.length - 1]   // the reactive proxy — mutations on it must be observable
    },
    removeJob(id) { const j = this.jobs.find(j => j.id === id); if (j && (j.finishedAt || j.status === 'queued')) { if (j.status === 'queued') this.cancelJob(id); this.jobs = this.jobs.filter(x => x.id !== id) } },
    _sequential(jobs, start) {
      const next = () => { const j = jobs.shift(); if (!j) return; if (j.status === 'cancelled') return next(); start(j, next) }
      next()
    },
    _finish(job, status) { job.status = status; job.finishedAt = Date.now() },
    cancelJob(id) {
      const job = this.jobs.find(j => j.id === id)
      if (!job || job.finishedAt) return
      job.cancelled = true
      const c = job.chapterId ? this.chapter(job.bookId, job.chapterId) : null
      if (job.status === 'queued') {
        this._finish(job, 'cancelled')
        if (c && job.kind === 'scripting') c.scripting = 'none'
        if (c && job.kind === 'narration') c.narration = c.duration ? 'done' : 'none'
      }
      // running jobs notice `cancelled` on their next tick
    },
    retryJob(id) {
      const job = this.jobs.find(j => j.id === id)
      if (!job) return
      if (job.kind === 'scripting') this.runScripting(job.bookId, [job.chapterId])
      if (job.kind === 'narration') { const c = this.chapter(job.bookId, job.chapterId); c.narration === 'failed' && this.segmentsOf(job.bookId, c.id).some(x => x.audio.status === 'done') ? this.retryFailed(job.bookId, c.id) : this.runNarration(job.bookId, [c.id]) }
    },
    clearFinished() { this.jobs = this.jobs.filter(j => !j.finishedAt) },
    cancelAll() { for (const j of this.jobs.filter(j => j.status === 'queued')) this.cancelJob(j.id); for (const j of this.jobs.filter(j => j.status === 'running')) this.cancelJob(j.id) },
    retryAllFailed() {
      // one retry per chapter, grouped by book so each book's chapters queue in order
      const seen = new Set()
      for (const j of this.jobs.filter(j => j.status === 'failed' && j.kind !== 'export')) {
        const key = `${j.kind}:${j.bookId}:${j.chapterId}`
        if (seen.has(key)) continue; seen.add(key)
        const c = this.chapter(j.bookId, j.chapterId)
        if (j.kind === 'scripting' && c.scripting === 'failed') this.retryJob(j.id)
        if (j.kind === 'narration' && c.narration === 'failed') this.retryJob(j.id)
      }
    },

    // ---------- library ----------
    _blankChapters(count, volumeId, startAt, prefix = 'Chapter') {
      return Array.from({ length: count }, (_, i) => ({ id: startAt + i, index: startAt + i, volumeId, volumeIndex: i + 1, title: `${prefix} ${i + 1}`, words: 3000, scripting: 'none', scriptingProgress: 0, narration: 'none', narrationProgress: 0, duration: 0 }))
    },
    addNovel(file, title) {
      const id = 'new' + Date.now()
      const count = 12 + Math.floor(Math.random() * 10)
      this.books.push({ id, title: title || file.replace(/\.epub$/i, ''), author: 'Unknown', cover: ['#1e293b', '#94a3b8'], addedAt: 'just now', volumes: [{ id: 1, name: title || file.replace(/\.epub$/i, ''), file, from: 1, to: count }] })
      this.chapters[id] = this._blankChapters(count, 1, 1)
      this.characters[id] = [{ name: 'Narrator', aliases: [], gender: 'n', description: 'Narration, thoughts, and every speaker without a voice of their own.', voice: this.voiceOptions.find(o => !o.disabled)?.value ?? null, style: '', color: PALETTE[0], major: true }]
      return id
    },
    // A novel split across several EPUBs: each file becomes a volume, chapters keep numbering continuously
    // so roster / recap continuity can carry across the volume boundary.
    addVolume(bookId, file, name) {
      const book = this.bookById(bookId)
      const chs = this.chapters[bookId]
      const count = 8 + Math.floor(Math.random() * 8)
      const from = chs.length + 1
      const vol = { id: book.volumes.length + 1, name: name || `Vol. ${book.volumes.length + 1}`, file, from, to: from + count - 1 }
      book.volumes.push(vol)
      chs.push(...this._blankChapters(count, vol.id, from))
    },

    renameVolume(bookId, volId, name) {
      const v = this.bookById(bookId)?.volumes.find(v => v.id === volId)
      if (v && name.trim()) v.name = name.trim()
    },
    // Remove a volume (wrong EPUB added): its chapters, segments, jobs and exports go; the remaining
    // chapters are renumbered so numbering stays continuous. Removing the last volume removes the novel.
    removeVolume(bookId, volId) {
      const book = this.bookById(bookId); if (!book) return null
      if (book.volumes.length <= 1) { this.removeBook(bookId); return 'book' }
      const revert = this._bookSnapshot(bookId)
      const vname = book.volumes.find(v => v.id === volId)?.name
      const gone = new Set(this.chapters[bookId].filter(c => c.volumeId === volId).map(c => c.id))
      for (const j of this.jobs) if (j.bookId === bookId && gone.has(j.chapterId) && (j.status === 'running' || j.status === 'queued')) this.cancelJob(j.id)
      this.jobs = this.jobs.filter(j => !(j.bookId === bookId && gone.has(j.chapterId)))
      book.volumes = book.volumes.filter(v => v.id !== volId)
      this._renumber(bookId, this.chapters[bookId].filter(c => !gone.has(c.id)))
      this.toast(`Removed ${vname} · ${gone.size} chapters`, { undo: revert })
      return 'volume'
    },
    // Volumes are sortable: chapters follow the volume order and are renumbered continuously.
    moveVolume(bookId, volId, toIndex) {
      const book = this.bookById(bookId); if (!book) return
      const from = book.volumes.findIndex(v => v.id === volId); if (from < 0) return
      toIndex = Math.max(0, Math.min(book.volumes.length - 1, toIndex)); if (from === toIndex) return
      const vols = [...book.volumes]; const [v] = vols.splice(from, 1); vols.splice(toIndex, 0, v)
      book.volumes = vols
      const chs = this.chapters[bookId]
      this._renumber(bookId, vols.flatMap(v => chs.filter(c => c.volumeId === v.id).sort((a, b) => a.volumeIndex - b.volumeIndex)))
    },
    // give `ordered` chapters ids 1..n in that order; re-key segments, remap jobs/exports, fix volume ranges
    _renumber(bookId, ordered) {
      const book = this.bookById(bookId)
      const map = {}; ordered.forEach((c, i) => { map[c.id] = i + 1 })
      const segs = {}
      for (const [k, v] of Object.entries(this.segments)) {
        if (!k.startsWith(bookId + ':')) { segs[k] = v; continue }
        const old = Number(k.split(':')[1]); if (map[old]) segs[key(bookId, map[old])] = v
      }
      this.segments = segs
      ordered.forEach(c => { c.id = map[c.id]; c.index = c.id })
      this.chapters[bookId] = ordered
      let from = 1
      for (const v of book.volumes) { const mine = ordered.filter(c => c.volumeId === v.id); v.from = from; v.to = from + mine.length - 1; from += mine.length; mine.forEach((c, i) => c.volumeIndex = i + 1) }
      for (const j of this.jobs) if (j.bookId === bookId && j.chapterId != null && map[j.chapterId]) j.chapterId = map[j.chapterId]
      this.exports = this.exports.map(e => e.bookId !== bookId ? e : { ...e, chapterIds: e.chapterIds.filter(id => map[id]).map(id => map[id]) }).filter(e => e.bookId !== bookId || e.chapterIds.length)
      for (const e of this.exports) if (e.bookId === bookId) e.chapters = e.chapterIds.length
    },
    removeBook(bookId) {
      const revert = this._bookSnapshot(bookId); const title = this.bookById(bookId)?.title
      for (const j of this.jobs) if (j.bookId === bookId && (j.status === 'running' || j.status === 'queued')) this.cancelJob(j.id)
      this.jobs = this.jobs.filter(j => j.bookId !== bookId)
      this.books = this.books.filter(b => b.id !== bookId)
      delete this.chapters[bookId]; delete this.characters[bookId]
      this.segments = Object.fromEntries(Object.entries(this.segments).filter(([k]) => !k.startsWith(bookId + ':')))
      this.exports = this.exports.filter(e => e.bookId !== bookId)
      if (this.currentBookId === bookId) this.currentBookId = null
      this.toast(`Removed “${title}” from the library`, { undo: revert })
    },

    // ---------- demo ----------
    demoKick() {
      if (this._kicked) return; this._kicked = true
      setTimeout(() => {
        this.runScripting('drowned', [3, 4, 5])
        this.runNarration('cliche', [5, 6])
      }, 1200)
    },

    // ---------- scripting ----------
    runScripting(bookId, ids, { keepEdits = false } = {}) {
      if (this._blocked(bookId, 'script')) return
      const chs = this.chapters[bookId].filter(c => ids.includes(c.id) && !c.excluded && c.scripting !== 'running' && c.scripting !== 'queued')
      // re-scripting: remember what we had so the reader can show what changed (and optionally re-apply manual edits)
      for (const c of chs) if (this.segments[key(bookId, c.id)]?.length) { this._previous[key(bookId, c.id)] = clone(this.segments[key(bookId, c.id)]); c.rescript = { keepEdits } }
      const jobs = chs.map(c => { c.scripting = 'queued'; c.scriptingProgress = 0; return this.addJob('scripting', bookId, `Script · ch ${c.id}`, c.id) })
      this._sequential(jobs, (job, done) => {
        const c = this.chapter(bookId, job.chapterId)
        c.scripting = 'running'; job.status = 'running'; job.startedAt = Date.now()
        const t = setInterval(() => {
          if (job.cancelled) { clearInterval(t); c.scripting = 'none'; c.scriptingProgress = 0; this._finish(job, 'cancelled'); return done() }
          c.scriptingProgress = Math.min(100, c.scriptingProgress + rnd(5, 16))
          job.progress = c.scriptingProgress
          if (c.scriptingProgress >= 100) {
            clearInterval(t)
            const roll = Math.random()
            const outcome = roll < 0.06 ? 'failed' : roll < 0.16 ? 'fallback' : 'done'
            c.scripting = outcome
            this._finish(job, outcome === 'failed' ? 'failed' : 'done')
            if (outcome !== 'failed') {
              let segs = generateSegments(bookId, c.id, { aliasNoise: true })
              if (outcome === 'fallback') segs = collapseChunk(segs)   // verifier couldn't reconstruct one chunk → kept whole as narration
              const prev = this._previous[key(bookId, c.id)]
              if (prev) {   // mock a *different* LLM run: a few speakers move, one narration pair merges
                segs = reseg(segs)
                if (c.rescript?.keepEdits) for (const p of prev) if (p.edited) { const t = segs.find(x => x.text === p.text); if (t) { t.speaker = p.speaker; t.direction = p.direction; t.type = p.type; t.edited = true } }
              }
              this.segments[key(bookId, c.id)] = segs
              this._absorbCast(bookId, c.id)
              c.narration = 'none'; c.narrationProgress = 0; c.duration = 0
            }
            done()
          }
        }, 220)
      })
    },
    // Re-run the LLM on just the chunk that fell back. Simulated: replaced by properly split segments.
    retryChunk(bookId, chId, segId) {
      const segs = this.segmentsOf(bookId, chId)
      const i = segs.findIndex(x => x.id === segId)
      if (i < 0 || !segs[i].fallback) return
      const seg = segs[i]; seg.fallbackRetrying = true
      const job = this.addJob('scripting', bookId, `Re-split chunk · ch ${chId}`, chId)
      job.status = 'running'; job.startedAt = Date.now()
      setTimeout(() => {
        const fresh = generateSegments(bookId, chId).slice(0, seg.fallbackCount ?? 6).map((x, k) => ({ ...x, id: seg.id + k / 100 }))
        const cur = this.segmentsOf(bookId, chId); const j = cur.findIndex(x => x.id === segId)
        cur.splice(j, 1, ...fresh)
        cur.forEach((x, k) => x.id = k + 1)
        const c = this.chapter(bookId, chId)
        if (!cur.some(x => x.fallback)) c.scripting = 'done'
        this._absorbCast(bookId, chId)
        this._finish(job, 'done')
      }, 2500)
    },
    _absorbCast(bookId, chId) {
      const cast = this.characters[bookId]
      for (const s of this.segmentsOf(bookId, chId)) {
        if (!cast.some(c => c.name === s.speaker)) {
          cast.push({ name: s.speaker, aliases: [], gender: '?', description: '', voice: null, style: '', color: PALETTE[cast.length % PALETTE.length], major: false, isNew: true })
        }
      }
    },
    setSpeaker(bookId, chId, segId, speaker) {
      const s = this.segmentsOf(bookId, chId).find(x => x.id === segId)
      if (s && s.speaker !== speaker) { s.speaker = speaker; s.edited = true; this._markStale(bookId, chId, s) }
    },
    updateSegment(bookId, chId, segId, patch) {
      const s = this.segmentsOf(bookId, chId).find(x => x.id === segId)
      if (!s) return
      const changed = Object.keys(patch).some(k => s[k] !== patch[k])
      Object.assign(s, patch)
      if (changed) { s.edited = true; this._markStale(bookId, chId, s) }
    },
    dismissDiff(bookId, chId) { delete this._previous[key(bookId, chId)] },
    // edited after narration → existing audio no longer matches the script
    _markStale(bookId, chId, s) {
      if (s.audio.status === 'done' || s.audio.status === 'stale') {
        s.audio.status = 'stale'
        const c = this.chapter(bookId, chId); if (c.narration === 'done') c.narration = 'stale'
      }
    },
    renarrateStale(bookId, chId) {
      for (const s of this.segmentsOf(bookId, chId)) if (s.audio.status === 'stale') s.audio = { status: 'queued', endpoint: null, ms: 0, duration: 0 }
      this._resume(bookId, chId)
    },
    renameCharacter(bookId, from, to) {
      to = (to ?? '').trim(); if (!to || from === to) return
      const cast = this.characters[bookId]
      if (cast.some(c => c.name === to)) return this.mergeCharacter(bookId, from, to)
      const revert = this._castSnapshot(bookId)
      const c = cast.find(x => x.name === from)
      c.name = to; c.isNew = false
      this._replaceSpeaker(bookId, from, to)
      this.toast(`Renamed “${from}” to “${to}”`, { undo: revert })
    },
    mergeCharacter(bookId, from, into, { silent = false } = {}) {
      if (from === into) return
      const cast = this.characters[bookId]
      const src = cast.find(c => c.name === from)
      const dst = cast.find(c => c.name === into)
      if (!src || !dst) return
      const revert = this._castSnapshot(bookId)
      const n = this.lineCounts(bookId)[from] ?? 0
      dst.aliases = [...new Set([...dst.aliases, from, ...src.aliases])]
      this.characters[bookId] = cast.filter(c => c !== src)
      this._replaceSpeaker(bookId, from, into)
      if (!silent) this.toast(`Merged “${from}” into ${into} · ${n} line${n === 1 ? '' : 's'} moved`, { undo: revert })
    },
    mergeMany(bookId, names, into) {
      const revert = this._castSnapshot(bookId)
      let n = 0
      for (const name of names) if (name !== into) { this.mergeCharacter(bookId, name, into, { silent: true }); n++ }
      if (n) this.toast(`Merged ${n} speaker${n === 1 ? '' : 's'} into ${into}`, { undo: revert })
    },
    deleteCharacter(bookId, name) {
      const revert = this._castSnapshot(bookId)
      const n = this.lineCounts(bookId)[name] ?? 0
      this.mergeCharacter(bookId, name, 'Narrator', { silent: true })
      this.toast(`Removed “${name}” · ${n} line${n === 1 ? '' : 's'} now read by the Narrator`, { undo: revert })
    },
    autoAssignByGender(bookId) {
      // pool = voices on enabled endpoints, grouped by the gender tag the endpoint's voice list carries
      const all = this.enabledEndpoints.flatMap(e => e.voices.map(v => ({ ref: voiceRef(e.id, v.id), gender: v.gender })))
      if (!all.length) return
      const byGender = { m: all.filter(v => v.gender === 'm'), f: all.filter(v => v.gender === 'f'), n: all.filter(v => v.gender === 'n') }
      const used = {}
      for (const c of this.characters[bookId]) {
        if (c.voice || c.name === 'Narrator') continue
        const pool = byGender[c.gender]?.length ? byGender[c.gender] : all
        const i = used[c.gender] = (used[c.gender] ?? 0) + 1
        c.voice = pool[i % pool.length].ref
      }
    },

    // ---------- endpoints & their voices ----------
    addEndpoint() {
      this.endpoints.push({ id: 'ep' + Date.now(), name: 'New endpoint', baseUrl: 'https://', model: 'gpt-4o-mini-tts', concurrency: 1, enabled: false, latency: 1500, failRate: 0.03, price: 12, needsKey: true, maxChars: 0, splitAt: 'sentence', voices: [], history: [], failures: 0, rateLimits: 0, backoffUntil: 0, fetching: false })
      return this.endpoints[this.endpoints.length - 1]
    },
    removeEndpoint(id) {   // characters keep a dangling ref → shown as "missing" until undone or re-picked
      const i = this.endpoints.findIndex(e => e.id === id); if (i < 0) return
      const e = this.endpoints[i]; this.endpoints.splice(i, 1)
      this.toast(`Removed endpoint ${e.name}`, { undo: () => this.endpoints.splice(Math.min(i, this.endpoints.length), 0, e) })
    },
    addVoice(ep, { id, label, gender }) {
      id = (id ?? '').trim(); if (!id || ep.voices.some(v => v.id === id)) return false
      ep.voices.push({ id, label: (label ?? '').trim() || id, gender: gender ?? 'n' }); return true
    },
    removeVoice(ep, id) {
      const i = ep.voices.findIndex(v => v.id === id); if (i < 0) return
      const v = ep.voices[i]; ep.voices.splice(i, 1)
      this.toast(`Removed voice ${v.label} from ${ep.name}`, { undo: () => ep.voices.splice(Math.min(i, ep.voices.length), 0, v) })
    },
    // simulated GET /v1/audio/voices — most OpenAI-compatible servers (Kokoro-FastAPI, Orpheus…) expose one
    fetchVoices(ep) {
      ep.fetching = true
      return new Promise(res => setTimeout(() => {
        const added = DISCOVERABLE_VOICES.filter(v => !ep.voices.some(x => x.id === v.id)).map(v => ({ ...v }))
        ep.voices.push(...added); ep.fetching = false; res(added.length)
      }, 900))
    },
    // how many segments of this book a limit would split, for the endpoint card
    splitCount(bookId, ep) {
      if (!ep.maxChars) return 0
      let n = 0
      for (const k of Object.keys(this.segments)) if (k.startsWith(bookId + ':')) for (const s of this.segments[k]) if (this.effectiveVoice(bookId, s.speaker).endpoint?.id === ep.id && s.text.length > ep.maxChars) n++
      return n
    },
    _replaceSpeaker(bookId, from, to) {
      for (const k of Object.keys(this.segments)) {
        if (!k.startsWith(bookId + ':')) continue
        const chId = Number(k.split(':')[1])
        for (const s of this.segments[k]) if (s.speaker === from) { s.speaker = to; this._markStale(bookId, chId, s) }
      }
    },
    lineCounts(bookId, chId = null) {
      const counts = {}
      const keys = chId ? [key(bookId, chId)] : Object.keys(this.segments).filter(k => k.startsWith(bookId + ':'))
      for (const k of keys) for (const s of this.segments[k] ?? []) counts[s.speaker] = (counts[s.speaker] ?? 0) + 1
      return counts
    },

    // ---------- narration ----------
    runNarration(bookId, ids) {
      if (this._blocked(bookId, 'narrate')) return
      const chs = this.chapters[bookId].filter(c => ids.includes(c.id) && !c.excluded && isScripted(c) && !['running', 'queued'].includes(c.narration))
      const jobs = chs.map(c => { c.narration = 'queued'; c.narrationProgress = 0; return this.addJob('narration', bookId, `Narrate · ch ${c.id}`, c.id) })
      this._sequential(jobs, (job, done) => {
        const c = this.chapter(bookId, job.chapterId)
        for (const s of this.segmentsOf(bookId, c.id)) s.audio = { status: 'queued', endpoint: null, ms: 0, duration: 0 }
        this._dispatch(bookId, c, job, done)
      })
    },
    retrySegment(bookId, chId, segId) {
      const s = this.segmentsOf(bookId, chId).find(x => x.id === segId)
      if (s) s.audio = { status: 'queued', endpoint: null, ms: 0, duration: 0 }
      this._resume(bookId, chId)
    },
    retryFailed(bookId, chId) {
      for (const s of this.segmentsOf(bookId, chId)) if (s.audio.status === 'failed') s.audio = { status: 'queued', endpoint: null, ms: 0, duration: 0 }
      this._resume(bookId, chId)
    },
    _resume(bookId, chId) {
      const c = this.chapter(bookId, chId)
      if (c.narration === 'running') return
      const job = this.addJob('narration', bookId, `Retry · ch ${c.id}`, c.id)
      this._dispatch(bookId, c, job, () => {})
    },
    _dispatch(bookId, c, job, done) {
      c.narration = 'running'; job.status = 'running'; job.startedAt = Date.now()
      const segs = this.segmentsOf(bookId, c.id)
      const tick = () => {
        if (job.cancelled) {
          for (const s of segs) if (s.audio.status === 'queued') s.audio.status = 'none'
          if (!segs.some(s => s.audio.status === 'generating')) { c.narration = segs.every(s => s.audio.status === 'done') ? 'done' : 'failed'; this._finish(job, 'cancelled'); return done() }
          return setTimeout(tick, 200)
        }
        // A segment is rendered by the endpoint that owns its speaker's voice (falling back to the
        // Narrator's). Long text is split into `parts` requests against that endpoint's limit.
        for (const next of segs.filter(s => s.audio.status === 'queued')) {
          const route = this.effectiveVoice(bookId, next.speaker)
          const ep = route.endpoint
          if (!ep || !ep.enabled || (ep.needsKey && !keyring.has(ep.id))) {
            next.audio = { status: 'failed', endpoint: ep?.id ?? null, ms: 0, duration: 0, error: { code: 0, message: !route.ref ? 'no voice for speaker' : !ep ? `voice ${route.ref} no longer exists` : !ep.enabled ? `${ep.name} is paused` : `${ep.name} has no API key`, body: '' } }
            continue
          }
          if (ep.backoffUntil > Date.now()) continue
          const active = segs.filter(s => s.audio.status === 'generating' && s.audio.endpoint === ep.id).length
          if (active >= ep.concurrency) continue
          const cuts = splitText(next.text, ep.maxChars, ep.splitAt)
          const parts = cuts.length
          const who = (this.characters[bookId] ?? []).find(x => x.name === next.speaker)
          next.audio = { status: 'generating', endpoint: ep.id, ms: 0, duration: 0, startedAt: Date.now(), parts, cuts: parts > 1 ? cuts.map(c => ({ from: c.from, to: c.to, at: c.at, fallback: c.fallback })) : undefined, splitAt: ep.splitAt,
            // audit trail: exactly what this clip was rendered with, so later edits can be compared against it
            voiceRef: route.ref, voice: route.voice, model: ep.model, direction: next.direction, style: who?.style ?? '', type: next.type, at: Date.now(), cost: next.text.length / 1e6 * ep.price }
          const dur = ep.latency * rnd(0.5, 1.1) * parts + next.text.length * 6
          setTimeout(() => {
            if (Math.random() < 0.03) {   // rate limited → back off, put the segment back
              ep.backoffUntil = Date.now() + 4000; ep.rateLimits = (ep.rateLimits ?? 0) + 1
              ep.lastError = { code: 429, message: 'rate limited', body: '{"error":{"message":"Rate limit reached. Please retry after 4 seconds.","type":"rate_limit_error"}}', retryAfter: 4, at: Date.now() }
              next.audio = { status: 'queued', endpoint: null, ms: 0, duration: 0 }; return
            }
            const fail = Math.random() < ep.failRate
            next.audio.status = fail ? 'failed' : 'done'
            next.audio.ms = Math.round(dur)
            next.audio.duration = fail ? 0 : next.text.split(' ').length / 2.6
            if (fail) {
              const e = ERRORS[Math.floor(Math.random() * ERRORS.length)]
              next.audio.error = { ...e, part: parts > 1 ? 1 + Math.floor(Math.random() * parts) : undefined, at: Date.now() }
              ep.lastError = { ...next.audio.error }
            }
            ep.history = [...(ep.history ?? []), { t: Date.now(), ms: Math.round(dur), ok: !fail }].slice(-40)
            if (fail) ep.failures = (ep.failures ?? 0) + 1
          }, dur)
        }
        const pending = segs.filter(s => s.audio.status === 'queued' || s.audio.status === 'generating')
        const finished = segs.length - pending.length
        c.narrationProgress = Math.round(finished / segs.length * 100); job.progress = c.narrationProgress
        // stalled: nothing in flight and no queued segment can be placed (everything it needs is paused)
        const stalled = !segs.some(s => s.audio.status === 'generating') && !segs.some(s => s.audio.status === 'queued' && this.effectiveVoice(bookId, s.speaker).endpoint?.enabled)
        if (pending.length === 0 || stalled) {
          for (const s of segs) if (s.audio.status === 'queued') s.audio = { ...s.audio, status: 'failed', error: { code: 0, message: 'no endpoint available for this voice', body: '' } }
          const failed = segs.some(s => s.audio.status !== 'done')
          c.narration = failed ? 'failed' : 'done'
          c.duration = segs.reduce((a, s) => a + s.audio.duration, 0)
          this._finish(job, failed ? 'failed' : 'done')
          done(); return
        }
        setTimeout(tick, 200)
      }
      tick()
    },

    // ---------- export ----------
    // An export is identified by its filename. Building again with the same filename replaces the
    // previous audiobook (version bump, old entry kept as 'replaced'). With splitPerVolume, one
    // file is built per volume, each carrying volume metadata.
    buildExport(bookId, ids, meta) {
      if (this._blocked(bookId, 'build')) return []
      const book = this.bookById(bookId)
      const chs = this.chapters[bookId].filter(c => ids.includes(c.id))
      if (!chs.length) return []
      const groups = meta.splitPerVolume
        ? book.volumes.map((v, i) => ({ vol: v, index: i + 1, chapters: chs.filter(c => c.volumeId === v.id) })).filter(g => g.chapters.length)
        : [{ vol: null, index: null, chapters: chs }]
      return groups.map(g => this._buildOne(bookId, g, meta))
    },
    exportFilename(meta, vol) {
      const base = (meta.filename || meta.title || 'audiobook').replace(/\.m4b$/i, '')
      return vol ? `${base} - ${vol.name.split('·')[0].trim()}.m4b` : `${base}.m4b`
    },
    _buildOne(bookId, g, meta) {
      const book = this.bookById(bookId)
      const filename = this.exportFilename(meta, g.vol)
      const prev = this.exports.find(e => e.bookId === bookId && e.filename === filename && e.status === 'done')
      const job = this.addJob('export', bookId, `Build ${filename}`)
      this.exports.unshift({
        id: Date.now() + Math.random(), bookId, filename,
        title: g.vol ? `${meta.title} · ${g.vol.name.split('·')[0].trim()}` : meta.title,
        series: meta.series, volume: g.vol ? { number: g.index, name: g.vol.name, of: book.volumes.length } : null,
        author: meta.author, narrator: meta.narrator, year: meta.year, description: meta.description,
        chapterIds: g.chapters.map(c => c.id), chapters: g.chapters.length, markers: meta.markers === false ? 0 : g.chapters.length, customCover: !!meta.cover,
        duration: g.chapters.reduce((a, c) => a + c.duration, 0), bitrate: meta.bitrate, size: 0,
        createdAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
        version: prev ? prev.version + 1 : 1, replaces: prev?.id ?? null, status: 'building', progress: 0,
      })
      const entry = this.exports[0]
      job.status = 'running'; job.startedAt = Date.now()
      const t = setInterval(() => {
        if (job.cancelled) { clearInterval(t); this.exports = this.exports.filter(e => e !== entry); this._finish(job, 'cancelled'); return }
        entry.progress = Math.min(100, entry.progress + rnd(3, 9)); job.progress = entry.progress
        if (entry.progress >= 100) {
          clearInterval(t)
          entry.status = 'done'; entry.size = Math.round(entry.duration * meta.bitrate / 8 / 1024 * 1.04)
          if (prev) prev.status = 'replaced'
          this._finish(job, 'done')
        }
      }, 180)
      return entry
    },
    deleteExport(id) {
      const i = this.exports.findIndex(e => e.id === id); if (i < 0) return
      const e = this.exports[i]; this.exports.splice(i, 1)
      this.toast(`Deleted ${e.filename} v${e.version}`, { undo: () => this.exports.splice(Math.min(i, this.exports.length), 0, e) })
    },
    // narrated chapters that a finished export doesn't contain yet (new volume arrived, more chapters narrated)
    newSince(exp) {
      const narrated = this.chaptersOf(exp.bookId).filter(isNarrated).map(c => c.id)
      const scope = exp.volume ? this.chaptersOf(exp.bookId).filter(c => isNarrated(c) && this.bookById(exp.bookId).volumes[exp.volume.number - 1]?.id === c.volumeId).map(c => c.id) : narrated
      return scope.filter(id => !exp.chapterIds.includes(id))
    },
  },
})
