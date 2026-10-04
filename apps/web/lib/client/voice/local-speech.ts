/**
 * The browser half of local speech sensing (plan §7.2 "user speaking"; live run D): reads the voice
 * SDK's microphone analyser every 20 ms — the very track the conversation streams, so no extra
 * permission and no second capture — turns its spectrum into a speech-band level and runs the core
 * detector (`stepLocalSpeech`). Only transitions are reported. A muted microphone reads as silence.
 */
import { INITIAL_LOCAL_SPEECH_STATE, byteSpectrumLevelDb, stepLocalSpeech, type GateClock } from "@vashistha/core";

export const LEVEL_POLL_MS = 20;

/**
 * The SDK resamples its analyser's 100–8000 Hz range linearly into the bins it returns; the lower
 * half (≈ 100–4000 Hz) holds most speech energy and leaves out broadband hiss above it.
 */
const SPEECH_BAND_FRACTION = 0.5;

/** Speech-band level (dB) of the SDK's voice-range byte spectrum. */
export function speechBandLevelDb(spectrum: Uint8Array): number {
  return byteSpectrumLevelDb(spectrum.subarray(0, Math.ceil(spectrum.length * SPEECH_BAND_FRACTION)));
}

export type LocalSpeechSensor = { stop: () => void };

/** Starts polling `readSpectrum` (the conversation's `getInputByteFrequencyData`) until stopped. */
export function startLocalSpeechSensor(options: {
  readSpectrum: () => Uint8Array;
  clock: GateClock;
  onChange: (speaking: boolean) => void;
}): LocalSpeechSensor {
  const { clock } = options;
  let state = INITIAL_LOCAL_SPEECH_STATE;
  let cancel: (() => void) | null = null;
  let stopped = false;
  const poll = (): void => {
    const step = stepLocalSpeech(state, { t: clock.now(), levelDb: speechBandLevelDb(options.readSpectrum()) });
    state = step.state;
    if (step.changed) options.onChange(state.speaking);
    if (!stopped) cancel = clock.setTimer(poll, LEVEL_POLL_MS);
  };
  poll();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      cancel?.();
      if (state.speaking) options.onChange(false);
    },
  };
}
