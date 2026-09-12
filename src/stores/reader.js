// Reader preferences: typography + whether the cast rail is shown. Persisted per browser (localStorage).
import { defineStore } from 'pinia'

export const READER_DEFAULTS = { font: 'serif', size: 16, lineHeight: 1.75, width: 'normal', showCast: true }
const KEY = 'audiobook-ui.reader'

function load() { try { return JSON.parse(localStorage.getItem(KEY)) ?? {} } catch { return {} } }
export function saveReader(state) { try { localStorage.setItem(KEY, JSON.stringify(state)) } catch {} }

export const useReader = defineStore('reader', {
  state: () => ({ ...READER_DEFAULTS, ...load() }),
  getters: {
    fontClass: (s) => ({ serif: 'font-serif', sans: 'font-sans', mono: 'font-mono' })[s.font],
    widthClass: (s) => ({ narrow: 'max-w-xl', normal: 'max-w-2xl', wide: 'max-w-4xl' })[s.width],
    isDefault: (s) => Object.keys(READER_DEFAULTS).filter(k => k !== 'showCast').every(k => s[k] === READER_DEFAULTS[k]),
  },
  actions: { reset() { const keep = this.showCast; Object.assign(this, READER_DEFAULTS, { showCast: keep }) } },
})
