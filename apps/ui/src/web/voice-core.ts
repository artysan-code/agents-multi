// voice-core.ts — the voice composer's pure parts (ADR 0014, second round): which format the browser records, the
// limits, the clock and the level meter, the language of dictation, and how dictated words join the text. The
// recorder itself is voice.ts.

/** A voice note stops at five minutes or ten megabytes, whichever comes first. */
export const MAX_SECONDS = 300;
export const MAX_BYTES = 10 * 1024 * 1024;

export interface RecorderType {
  mime: string;
  /** the file extension the upload carries */
  ext: string;
}

const TYPES: RecorderType[] = [
  { mime: "audio/webm;codecs=opus", ext: "webm" },
  { mime: "audio/webm", ext: "webm" },
  { mime: "audio/mp4;codecs=mp4a.40.2", ext: "m4a" },
  { mime: "audio/mp4", ext: "m4a" },
  { mime: "audio/ogg;codecs=opus", ext: "ogg" },
];

/** Pure: the first format the browser can record, Opus in WebM before AAC in MP4 (which is what Safari on iOS
 *  has); null when it can record none (the browser chooses its own, and the upload takes the extension from it). */
export function pickRecorderType(supported: (mime: string) => boolean): RecorderType | null {
  return TYPES.find((t) => supported(t.mime)) ?? null;
}

/** Pure: the extension for a recorded blob's type when the browser chose it. */
export function extOf(mime: string): string {
  if (/mp4|aac|m4a/.test(mime)) return "m4a";
  if (/ogg/.test(mime)) return "ogg";
  return "webm";
}

/** Pure: seconds as a clock, `0:07`, `4:59`. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Pure: how loud a slice of audio is, 0 to 1, from the analyser's time-domain bytes (128 is silence). Speech is
 *  quiet in RMS terms, so the scale is lifted to make a normal voice fill most of the meter. */
export function levelOf(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const d = (samples[i] - 128) / 128;
    sum += d * d;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 3.2);
}

/** Pure: the meter's last `n` levels, oldest first, with the new one added. */
export const pushLevel = (levels: number[], level: number, n = 28) => [...levels, level].slice(-n);

/** Pure: whether a slide from where the press began has gone far enough to cancel (to the left, or up). */
export const slidCancel = (dx: number, dy: number, far = 80) => dx < -far || dy < -far * 1.4;

/** Pure: the language dictation listens in: the app's, with the region the browser has for it. */
export function speechLang(app: "en" | "it", browser: string): string {
  const b = browser.replace("_", "-");
  if (b.toLowerCase().startsWith(app)) return b;
  return app === "it" ? "it-IT" : "en-US";
}

/** Pure: the box's text with the words spoken so far after what was already there, one space between. */
export function joinDictation(base: string, spoken: string): string {
  const s = spoken.trim();
  if (!s) return base;
  if (!base.trim()) return s;
  return `${base.replace(/\s+$/, "")} ${s}`;
}
