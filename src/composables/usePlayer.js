// Fake audio player: advances a position counter so variants can show playback without real audio.
import { reactive, onUnmounted } from "vue";

export function usePlayer() {
  const p = reactive({ id: null, pos: 0, len: 0, playing: false });
  let t = null;
  function play(id, len) {
    if (p.id === id && p.playing) return pause();
    if (p.id !== id) {
      p.pos = 0;
    }
    p.id = id;
    p.len = len;
    p.playing = true;
    clearInterval(t);
    t = setInterval(() => {
      p.pos += 0.1;
      if (p.pos >= p.len) {
        p.pos = p.len;
        pause();
      }
    }, 100);
  }
  function pause() {
    p.playing = false;
    clearInterval(t);
  }
  function seek(frac) {
    p.pos = frac * p.len;
  }
  onUnmounted(() => clearInterval(t));
  return { p, play, pause, seek };
}

export function speak(text, voice) {
  // Voice preview: real audio via the browser's own TTS so the button does *something*.
  try {
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    if (voices.length) u.voice = voices[Math.abs(hash(voice)) % voices.length];
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}
function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}
