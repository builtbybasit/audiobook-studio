// PROTOTYPE — in-memory state + simulated jobs. Nothing persists.
import { defineStore } from 'pinia'
import { makeWorld, generateSegments, PALETTE } from '../mock/data'

let jobSeq = 100
const key = (b, c) => `${b}:${c}`
const rnd = (a, b) => a + Math.random() * (b - a)

export const useApp = defineStore('app', {
  state: () => ({
    ...makeWorld(),
    jobs: [],
    dark: window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true,
    currentBookId: null,
  }),

  getters: {
    book: (s) => s.books.find(b => b.id === s.currentBookId),
    bookById: (s) => (id) => s.books.find(b => b.id === id),
    chaptersOf: (s) => (id) => s.chapters[id] ?? [],
    chapter: (s) => (bookId, chId) => (s.chapters[bookId] ?? []).find(c => c.id === chId),
    charactersOf: (s) => (id) => s.characters[id] ?? [],
    segmentsOf: (s) => (bookId, chId) => s.segments[key(bookId, chId)] ?? [],
    progress: (s) => (id) => {
      const ch = s.chapters[id] ?? []
      return {
        total: ch.length,
        scripted: ch.filter(c => c.scripting === 'done').length,
        narrated: ch.filter(c => c.narration === 'done').length,
        exported: s.exports.filter(e => e.bookId === id).length,
        running: ch.some(c => c.scripting === 'running' || c.narration === 'running'),
      }
    },
    activeJobs: (s) => s.jobs.filter(j => j.status === 'running' || j.status === 'queued'),
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
      const job = { id: jobSeq++, kind, bookId, chapterId, label, status: 'queued', progress: 0, startedAt: null }
      this.jobs.push(job)
      return job
    },
    _sequential(jobs, start) {
      const next = () => { const j = jobs.shift(); if (j) start(j, next) }
      next()
    },

    // ---------- scripting ----------
    runScripting(bookId, ids) {
      const chs = this.chapters[bookId].filter(c => ids.includes(c.id) && c.scripting !== 'running' && c.scripting !== 'queued')
      const jobs = chs.map(c => { c.scripting = 'queued'; c.scriptingProgress = 0; return this.addJob('scripting', bookId, `Script · ch ${c.id}`, c.id) })
      this._sequential(jobs, (job, done) => {
        const c = this.chapter(bookId, job.chapterId)
        c.scripting = 'running'; job.status = 'running'; job.startedAt = Date.now()
        const t = setInterval(() => {
          c.scriptingProgress = Math.min(100, c.scriptingProgress + rnd(5, 16))
          job.progress = c.scriptingProgress
          if (c.scriptingProgress >= 100) {
            clearInterval(t)
            const fail = Math.random() < 0.07
            c.scripting = fail ? 'failed' : 'done'
            job.status = fail ? 'failed' : 'done'
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
          job.status = failed ? 'failed' : 'done'
          done(); return
        }
        setTimeout(tick, 200)
      }
      tick()
    },

    // ---------- export ----------
    buildExport(bookId, ids, meta) {
      const book = this.bookById(bookId)
      const chs = this.chapters[bookId].filter(c => ids.includes(c.id))
      const job = this.addJob('export', bookId, `Build M4B · ${chs.length} ch`)
      const entry = { id: Date.now(), bookId, title: meta.title || book.title, chapters: chs.length, duration: chs.reduce((a, c) => a + c.duration, 0), bitrate: meta.bitrate, size: 0, createdAt: new Date().toISOString().slice(0, 16).replace('T', ' '), status: 'building', progress: 0 }
      this.exports.unshift(entry)
      job.status = 'running'; job.startedAt = Date.now()
      const t = setInterval(() => {
        entry.progress = Math.min(100, entry.progress + rnd(3, 9)); job.progress = entry.progress
        if (entry.progress >= 100) {
          clearInterval(t)
          entry.status = 'done'; entry.size = Math.round(entry.duration * meta.bitrate / 8 / 1024 * 1.04)
          job.status = 'done'
        }
      }, 180)
      return entry
    },
  },
})
