/**
 * Text-to-speech through the Web Speech API.
 *
 * Deliberately no cloud TTS: the phone already ships a voice, it works
 * offline, it costs nothing, and it needs no API key. The trade-off is that
 * voice quality and the available voice list vary by device.
 */

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * Chrome populates the voice list asynchronously, so callers should also
 * subscribe via `onVoicesChanged`.
 */
export function listVoices(): SpeechSynthesisVoice[] {
  if (!speechSupported()) return [];
  return window.speechSynthesis
    .getVoices()
    .filter((voice) => voice.lang.toLowerCase().startsWith("en"))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function onVoicesChanged(callback: () => void): () => void {
  if (!speechSupported()) return () => undefined;
  const synth = window.speechSynthesis;
  synth.addEventListener("voiceschanged", callback);
  return () => synth.removeEventListener("voiceschanged", callback);
}

export interface SpeakOptions {
  voiceUri?: string | null;
  rate?: number;
  onEnd?: () => void;
}

/** Speaks `text`, cancelling anything already in progress. */
export function speak(text: string, options: SpeakOptions = {}): void {
  if (!speechSupported() || !text.trim()) return;
  const synth = window.speechSynthesis;
  synth.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = clamp(options.rate ?? 1, 0.5, 2);
  utterance.pitch = 1;
  if (options.voiceUri) {
    const voice = window.speechSynthesis
      .getVoices()
      .find((candidate) => candidate.voiceURI === options.voiceUri);
    if (voice) utterance.voice = voice;
  }
  if (options.onEnd) {
    utterance.addEventListener("end", options.onEnd);
    utterance.addEventListener("error", options.onEnd);
  }
  synth.speak(utterance);
}

export function stopSpeaking(): void {
  if (!speechSupported()) return;
  window.speechSynthesis.cancel();
}

export function isSpeaking(): boolean {
  return speechSupported() && window.speechSynthesis.speaking;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
