// Hearing a voice before choosing it: the demo buttons beside a speaker and in the voice picker.
//
// What plays is the voice itself, as the server has it (`endpointsStore.sampleVoice`): the
// provider's own recording of it where it keeps one — Fish does, free — or else the endpoint saying
// the sample sentence, a real request billed once and kept on the server from then on. Played on
// the one player, so pressing the same voice again pauses it.
import { ref } from "vue";
import { usePlayer } from "@/composables/usePlayer";
import { useEndpointsStore } from "@/stores/endpoints";
import type { Endpoint, VoiceRef } from "@/types";

/** What the player calls a voice's sample; the Voices tab and the demo buttons share it. */
export const sampleId = (endpointId: string, voiceId: string): string =>
  `sample:${endpointId}/${voiceId}`;

/** Say on a button what pressing it costs. */
export const SAMPLE_TITLE =
  "Hear this voice — the provider's own recording where it has one, otherwise the endpoint says a sentence: a real request, billed once and kept";

export function useVoiceSample() {
  const endpointsStore = useEndpointsStore();
  const player = usePlayer();
  /** the sample being fetched, if any; one at a time */
  const loading = ref<string | null>(null);

  /** One fetch at a time, known by the player id it will play under. */
  async function oneAtATime(id: string, work: () => Promise<void>): Promise<void> {
    if (loading.value) return;
    loading.value = id;
    try {
      await work();
    } finally {
      loading.value = null;
    }
  }

  /**
   * A voice's sample, played under `id` — the voice's own sample id unless the caller keeps a
   * separate one (the Voices tab's public search does, for a voice that is not on the list yet).
   * A sample the server timed plays at once; one only its file can time is read for it first.
   */
  function play(
    ep: Endpoint,
    voiceId: string,
    title = voiceId,
    id = sampleId(ep.id, voiceId),
  ): Promise<void> {
    return oneAtATime(id, async () => {
      const sample = await endpointsStore.sampleVoice(ep, voiceId);
      if (!sample) return;
      if (sample.duration) player.play(id, sample.duration, sample.url);
      else await player.playFile(id, sample.url, title);
    });
  }

  /** A recording the provider serves itself, such as Fish's own sample of a public voice. */
  function playUrl(id: string, url: string, title: string): Promise<void> {
    return oneAtATime(id, () => player.playFile(id, url, title));
  }

  /** Whether the player is playing what it was given under `id`. */
  const playingId = (id: string): boolean => player.p.id === id && player.p.playing;

  /** The voice a reference names; nothing when it names none this library has. */
  function playRef(ref: VoiceRef | null | undefined): Promise<void> {
    const r = endpointsStore.resolveVoice(ref);
    return r ? play(r.endpoint, r.voice.id, r.voice.label) : Promise.resolve();
  }

  const playing = (ref: VoiceRef | null | undefined): boolean => {
    const r = endpointsStore.resolveVoice(ref);
    return !!r && playingId(sampleId(r.endpoint.id, r.voice.id));
  };
  const fetching = (ref: VoiceRef | null | undefined): boolean => {
    const r = endpointsStore.resolveVoice(ref);
    return !!r && loading.value === sampleId(r.endpoint.id, r.voice.id);
  };

  return { play, playUrl, playRef, playing, playingId, fetching, loading };
}
