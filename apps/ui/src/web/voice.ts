// voice.ts — recording a voice note in the browser (ADR 0014, second round): the microphone, MediaRecorder in the
// format the browser has (Opus in WebM, or AAC in MP4 on iOS), a level for the meter, the clock, and the limits.
// What decides the format, the limits and the meter's arithmetic is voice-core.ts.

import { extOf, levelOf, MAX_BYTES, MAX_SECONDS, pickRecorderType } from "./voice-core.ts";

export interface Take {
  blob: Blob;
  ext: string;
  seconds: number;
}

interface Hooks {
  onLevel: (level: number) => void;
  onTick: (seconds: number) => void;
  /** the five minutes or the ten megabytes are used: the caller ends the note */
  onLimit: () => void;
}

export const canRecord = () => typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

export class Recorder {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private bytes = 0;
  private ctx: AudioContext | null = null;
  private timer = 0;
  private t0 = 0;
  private limited = false;

  constructor(private hooks: Hooks) {}

  /** Opens the microphone and starts. Throws the browser's error (NotAllowedError when it is blocked). */
  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const type = pickRecorderType((m) => MediaRecorder.isTypeSupported?.(m) ?? false);
    this.rec = new MediaRecorder(this.stream, type ? { mimeType: type.mime, audioBitsPerSecond: 32_000 } : undefined);
    this.rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      this.chunks.push(e.data);
      this.bytes += e.data.size;
      // a little under the limit, so the last piece the recorder still delivers fits
      if (this.bytes >= MAX_BYTES - 128 * 1024) this.limit();
    };
    this.rec.start(1000);
    this.t0 = performance.now();

    // the meter: an analyser on the same stream, read about fifteen times a second
    let analyser: AnalyserNode | null = null;
    try {
      const AC = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AC) {
        this.ctx = new AC();
        analyser = this.ctx.createAnalyser();
        analyser.fftSize = 512;
        this.ctx.createMediaStreamSource(this.stream).connect(analyser);
      }
    } catch { /* no meter; the note records all the same */ }
    const buf = new Uint8Array(analyser?.fftSize ?? 0);
    this.timer = setInterval(() => {
      const s = (performance.now() - this.t0) / 1000;
      this.hooks.onTick(s);
      if (analyser) {
        analyser.getByteTimeDomainData(buf);
        this.hooks.onLevel(levelOf(buf));
      }
      if (s >= MAX_SECONDS) this.limit();
    }, 66) as unknown as number;
  }

  private limit() {
    if (this.limited) return;
    this.limited = true;
    this.hooks.onLimit();
  }

  /** Ends the note and gives what was recorded. */
  stop(): Promise<Take> {
    const rec = this.rec;
    const seconds = (performance.now() - this.t0) / 1000;
    return new Promise((resolve, reject) => {
      if (!rec || rec.state === "inactive") {
        this.release();
        return reject(new Error("not recording"));
      }
      rec.onstop = () => {
        const type = rec.mimeType || "audio/webm";
        const blob = new Blob(this.chunks, { type });
        this.release();
        resolve({ blob, ext: extOf(type), seconds: Math.min(seconds, MAX_SECONDS) });
      };
      rec.stop();
    });
  }

  /** Throws the note away. */
  cancel(): void {
    const rec = this.rec;
    if (rec && rec.state !== "inactive") {
      rec.onstop = null;
      rec.ondataavailable = null;
      rec.stop();
    }
    this.release();
  }

  private release() {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
  }
}

/** The browser's speech recognition, where it has one (Safari and Chrome call it `webkitSpeechRecognition`). */
export interface Dictation {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
export function dictation(): (new () => Dictation) | null {
  const g = globalThis as unknown as { SpeechRecognition?: new () => Dictation; webkitSpeechRecognition?: new () => Dictation };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}
