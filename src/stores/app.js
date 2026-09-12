// PROTOTYPE — in-memory state + simulated jobs. Nothing persists.
import { defineStore } from 'pinia'
import { makeWorld, generateSegments, PALETTE } from '../mock/data'

let jobSeq = 100
const ago = (min) => Date.now() - min * 60000
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
        scripted: ch.filter(c => c.scripting === 'done').length,
        narrated: ch.filter(c => c.narration === 'done').length,
        exported: s.exports.filter(e => e.bookId === id && e.status === 'done').length,
        running: ch.some(c => c.scripting === 'running' || c.narration === 'running'),
      }
    },
    activeJobs: (s) => s.jobs.filter(j => j.status === 'running' || j.status === 'queued'),
    endpointLoad: (s) => {
      const load = Object.fromEntries(s.endpoints.map(e => [e.id, { active: 0, done: 0, failed: 0 }]))
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
    // a character with no voice of their own is read in the Narrator's voice
    effectiveVoice: (s) => (bookId, name) => {
      const cast = s.characters[bookId] ?? []
      const c = cast.find(x => x.name === name)
      if (c?.voice) return { voice: c.voice, own: true }
      return { voice: cast.find(x => x.name === 'Narrator')?.voice ?? null, own: false }
    },
    estimate: (s) => (bookId, ids) => {
      let chars = 0
      for (const id of ids) for (const seg of s.segments[`${bookId}:${id}`] ?? []) chars += seg.text.length
      const enabled = s.endpoints.filter(e => e.enabled)
      const price = enabled.length ? enabled.reduce((a, e) => a + e.price, 0) / enabled.length : 0
      return { chapters: ids.length, chars, seconds: chars / 15.5, cost: chars / 1e6 * price, endpoints: enabled.length }
    },
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
            const fail = Math.random() < 0.07
            c.scripting = fail ? 'failed' : 'done'
            this._finish(job, fail ? 'failed' : 'done')
            if (!fail) {
              this.segments[key(bookId, c.id)] = generateSegments(bookId, c.id, { aliasNoise: true })
              this._absorbCast(bookId, c.id)
              c.narration = 'none'; c.narrationProgress = 0; c.duration = 0
            }
            done()
          }
        }, 220)
      })
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
      if (s) { s.speaker = speaker; s.audio = { status: 'none', endpoint: null, ms: 0, duration: 0 } }
    },
    updateSegment(bookId, chId, segId, patch) {
      const s = this.segmentsOf(bookId, chId).find(x => x.id === segId)
      if (s) Object.assign(s, patch)
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
      const byGender = { m: ['onyx', 'echo', 'ash', 'fable'], f: ['nova', 'shimmer', 'coral', 'sage'], n: ['alloy', 'verse'], '?': ['alloy', 'ballad'] }
      const used = {}
      for (const c of this.characters[bookId]) {
        if (c.voice || c.name === 'Narrator') continue
        const pool = byGender[c.gender] ?? byGender['?']
        const i = used[c.gender] = (used[c.gender] ?? 0) + 1
        c.voice = pool[i % pool.length]
      }
    },
    _replaceSpeaker(bookId, from, to) {
      for (const k of Object.keys(this.segments)) {
        if (!k.startsWith(bookId + ':')) continue
        for (const s of this.segments[k]) if (s.speaker === from) s.speaker = to
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
      const chs = this.chapters[bookId].filter(c => ids.includes(c.id) && c.scripting === 'done' && !['running', 'queued'].includes(c.narration))
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
        for (const ep of this.enabledEndpoints) {
          const active = segs.filter(s => s.audio.status === 'generating' && s.audio.endpoint === ep.id).length
          let slots = ep.concurrency - active
          while (slots-- > 0) {
            const next = segs.find(s => s.audio.status === 'queued')
            if (!next) break
            next.audio.status = 'generating'; next.audio.endpoint = ep.id; next.audio.startedAt = Date.now()
            const dur = ep.latency * rnd(0.5, 1.1) + next.text.length * 6
            setTimeout(() => {
              const fail = Math.random() < ep.failRate
              next.audio.status = fail ? 'failed' : 'done'
              next.audio.ms = Math.round(dur)
              next.audio.duration = fail ? 0 : next.text.split(' ').length / 2.6
            }, dur)
          }
        }
        const pending = segs.filter(s => s.audio.status === 'queued' || s.audio.status === 'generating')
        const finished = segs.length - pending.length
        c.narrationProgress = Math.round(finished / segs.length * 100); job.progress = c.narrationProgress
        const stalled = this.enabledEndpoints.length === 0 && !segs.some(s => s.audio.status === 'generating')
        if (pending.length === 0 || stalled) {
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
      const narrated = this.chaptersOf(exp.bookId).filter(c => c.narration === 'done').map(c => c.id)
      const scope = exp.volume ? this.chaptersOf(exp.bookId).filter(c => c.narration === 'done' && this.bookById(exp.bookId).volumes[exp.volume.number - 1]?.id === c.volumeId).map(c => c.id) : narrated
      return scope.filter(id => !exp.chapterIds.includes(id))
    },
  },
})
