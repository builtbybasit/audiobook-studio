// PROTOTYPE — in-memory state + simulated jobs. Nothing persists.
import { defineStore } from 'pinia'
import { makeWorld, generateSegments, PALETTE, DISCOVERABLE_VOICES, voiceRef } from '../mock/data'

let jobSeq = 100
export const isScripted = (c) => c.scripting === 'done' || c.scripting === 'fallback'
export const isNarrated = (c) => c.narration === 'done' || c.narration === 'stale'
export const norm = (n) => n.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
export { voiceRef }
// how many requests a text needs on an endpoint with a per-request character limit (0 = unlimited)
export const partsFor = (text, ep) => ep?.maxChars ? Math.max(1, Math.ceil(text.length / ep.maxChars)) : 1
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
const rnd = (a, b) => a + Math.random() * (b - a)

export const useApp = defineStore('app', {
  state: () => ({
    ...makeWorld(),
    profiles: [
      { id: 'openai', name: 'OpenAI', model: 'gpt-4o-mini', inPrice: 0.15, outPrice: 0.6, secPerChunk: 9, apiKey: 'sk-••••4f2a' },
      { id: 'deepseek', name: 'DeepSeek', model: 'deepseek-chat', inPrice: 0.14, outPrice: 0.28, secPerChunk: 14, apiKey: 'ds-••••91cd' },
      { id: 'antigravity', name: 'Antigravity (local)', model: 'gemini-3.6-flash-low', inPrice: 0, outPrice: 0, secPerChunk: 25, apiKey: '' },
    ],
    scriptSettings: { profile: 'openai', chunkChars: 6000, stripWatermarks: true },
    jobs: seedJobs(),
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
      const ch = s.chapters[id] ?? []
      return {
        total: ch.length,
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
        else if (r.endpoint.needsKey && !r.endpoint.apiKey) out.push({ name: c.name, ref: c.voice, reason: `${r.endpoint.name} has no API key`, kind: 'nokey', endpoint: r.endpoint })
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
      this.characters[id] = [{ name: 'Narrator', aliases: [], gender: 'n', description: 'Narration, thoughts, and every speaker without a voice of their own.', voice: 'alloy', style: '', color: PALETTE[0], major: true }]
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

    // ---------- demo ----------
    demoKick() {
      if (this._kicked) return; this._kicked = true
      setTimeout(() => {
        this.runScripting('drowned', [3, 4, 5])
        this.runNarration('cliche', [5, 6])
      }, 1200)
    },

    // ---------- scripting ----------
    runScripting(bookId, ids) {
      const chs = this.chapters[bookId].filter(c => ids.includes(c.id) && c.scripting !== 'running' && c.scripting !== 'queued')
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
      if (s && s.speaker !== speaker) { s.speaker = speaker; this._markStale(bookId, chId, s) }
    },
    updateSegment(bookId, chId, segId, patch) {
      const s = this.segmentsOf(bookId, chId).find(x => x.id === segId)
      if (!s) return
      const changed = Object.keys(patch).some(k => s[k] !== patch[k])
      Object.assign(s, patch)
      if (changed) this._markStale(bookId, chId, s)
    },
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
      to = to.trim(); if (!to || from === to) return
      const cast = this.characters[bookId]
      if (cast.some(c => c.name === to)) return this.mergeCharacter(bookId, from, to)
      const c = cast.find(x => x.name === from)
      c.name = to; c.isNew = false
      this._replaceSpeaker(bookId, from, to)
    },
    mergeCharacter(bookId, from, into) {
      if (from === into) return
      const cast = this.characters[bookId]
      const src = cast.find(c => c.name === from)
      const dst = cast.find(c => c.name === into)
      if (!src || !dst) return
      dst.aliases = [...new Set([...dst.aliases, from, ...src.aliases])]
      this.characters[bookId] = cast.filter(c => c !== src)
      this._replaceSpeaker(bookId, from, into)
    },
    deleteCharacter(bookId, name) { this.mergeCharacter(bookId, name, 'Narrator') },
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
      this.endpoints.push({ id: 'ep' + Date.now(), name: 'New endpoint', baseUrl: 'https://', apiKey: '', model: 'gpt-4o-mini-tts', concurrency: 1, enabled: false, latency: 1500, failRate: 0.03, price: 12, needsKey: true, maxChars: 0, voices: [], history: [], failures: 0, rateLimits: 0, backoffUntil: 0, fetching: false })
      return this.endpoints[this.endpoints.length - 1]
    },
    removeEndpoint(id) { this.endpoints = this.endpoints.filter(e => e.id !== id) },   // characters keep a dangling ref → shown as "missing"
    addVoice(ep, { id, label, gender }) {
      id = (id ?? '').trim(); if (!id || ep.voices.some(v => v.id === id)) return false
      ep.voices.push({ id, label: (label ?? '').trim() || id, gender: gender ?? 'n' }); return true
    },
    removeVoice(ep, id) { ep.voices = ep.voices.filter(v => v.id !== id) },
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
      const chs = this.chapters[bookId].filter(c => ids.includes(c.id) && isScripted(c) && !['running', 'queued'].includes(c.narration))
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
          if (!ep || !ep.enabled || (ep.needsKey && !ep.apiKey)) {
            next.audio = { status: 'failed', endpoint: ep?.id ?? null, ms: 0, duration: 0, error: !route.ref ? 'no voice for speaker' : !ep ? `voice ${route.ref} no longer exists` : !ep.enabled ? `${ep.name} is paused` : `${ep.name} has no API key` }
            continue
          }
          if (ep.backoffUntil > Date.now()) continue
          const active = segs.filter(s => s.audio.status === 'generating' && s.audio.endpoint === ep.id).length
          if (active >= ep.concurrency) continue
          const parts = partsFor(next.text, ep)
          next.audio = { status: 'generating', endpoint: ep.id, ms: 0, duration: 0, startedAt: Date.now(), parts, voice: route.voice }
          const dur = ep.latency * rnd(0.5, 1.1) * parts + next.text.length * 6
          setTimeout(() => {
            if (Math.random() < 0.03) {   // rate limited → back off, put the segment back
              ep.backoffUntil = Date.now() + 4000; ep.rateLimits = (ep.rateLimits ?? 0) + 1
              next.audio = { status: 'queued', endpoint: null, ms: 0, duration: 0 }; return
            }
            const fail = Math.random() < ep.failRate
            next.audio.status = fail ? 'failed' : 'done'
            next.audio.ms = Math.round(dur)
            next.audio.duration = fail ? 0 : next.text.split(' ').length / 2.6
            if (fail) next.audio.error = parts > 1 ? `part ${1 + Math.floor(Math.random() * parts)}/${parts} failed` : 'server error'
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
          for (const s of segs) if (s.audio.status === 'queued') s.audio = { ...s.audio, status: 'failed', error: 'no endpoint available for this voice' }
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
        chapterIds: g.chapters.map(c => c.id), chapters: g.chapters.length,
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
    deleteExport(id) { this.exports = this.exports.filter(e => e.id !== id) },
    // narrated chapters that a finished export doesn't contain yet (new volume arrived, more chapters narrated)
    newSince(exp) {
      const narrated = this.chaptersOf(exp.bookId).filter(isNarrated).map(c => c.id)
      const scope = exp.volume ? this.chaptersOf(exp.bookId).filter(c => isNarrated(c) && this.bookById(exp.bookId).volumes[exp.volume.number - 1]?.id === c.volumeId).map(c => c.id) : narrated
      return scope.filter(id => !exp.chapterIds.includes(id))
    },
  },
})
