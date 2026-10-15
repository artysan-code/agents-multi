// voice.ts — this machine transcribing a voice note (ADR 0014, second round). The phone records, the service keeps
// the audio until the turn ends, and a node that has whisper.cpp and ffmpeg takes the turn: it fetches the audio,
// converts it to 16 kHz mono WAV in a temporary folder, transcribes it locally in the account's language and posts
// the text as the turn's first event. The audio never leaves the person's machines but for the service's copy.
// Both programs run with an empty environment (no secrets, a headless node's token included); ffmpeg reads local
// files only, with the container named by the recording's type, never guessed from its content; and, where the
// sandbox tool is there, both run with no network at all. Everything that touches the machine goes through `VoiceIO`, so the
// tests run the whole flow with a fake whisper and a fake ffmpeg.

import { type VoiceConfig, voicePath } from "../../../shared/mcp/lib/headless.ts";
import { HOME } from "../lib/paths.ts";
import { owner } from "../../../shared/mcp/lib/owner.ts";

/** How a program is run: its exit code and what it wrote. */
export type CmdRunner = (
  cmd: string,
  args: string[],
  o?: { signal?: AbortSignal },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface VoiceIO {
  run: CmdRunner;
  /** a new private temporary folder */
  tempDir: () => Promise<string>;
  write: (path: string, data: Uint8Array) => Promise<void>;
  remove: (dir: string) => Promise<void>;
}

// ---------------------------------------------------------------- the language

const LANGUAGES: Record<string, string> = {
  italian: "it",
  italiano: "it",
  english: "en",
  inglese: "en",
  french: "fr",
  francais: "fr",
  francese: "fr",
  german: "de",
  deutsch: "de",
  tedesco: "de",
  spanish: "es",
  espanol: "es",
  spagnolo: "es",
  portuguese: "pt",
  portugues: "pt",
  portoghese: "pt",
  dutch: "nl",
  nederlands: "nl",
  olandese: "nl",
  catalan: "ca",
  catalano: "ca",
  polish: "pl",
  polacco: "pl",
  russian: "ru",
  russo: "ru",
  ukrainian: "uk",
  turkish: "tr",
  swedish: "sv",
  danish: "da",
  norwegian: "no",
  finnish: "fi",
  greek: "el",
  czech: "cs",
  romanian: "ro",
  hungarian: "hu",
  arabic: "ar",
  hebrew: "he",
  hindi: "hi",
  japanese: "ja",
  korean: "ko",
  chinese: "zh",
  indonesian: "id",
  vietnamese: "vi",
  thai: "th",
};

/** Pure: whisper's language code for the account's language: «Italian», «italiano», «it», «pt-BR» all map to the
 *  two-letter code; a language it does not know is `auto` (whisper detects it). */
export function whisperLanguage(name: string | undefined | null): string {
  const raw = (name ?? "").trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  if (!raw) return "auto";
  if (LANGUAGES[raw]) return LANGUAGES[raw];
  const code = raw.match(/^([a-z]{2})(?:[-_][a-z0-9]+)*$/)?.[1];
  if (code && Object.values(LANGUAGES).includes(code)) return code;
  if (code === "iw") return "he";
  return "auto";
}

// ---------------------------------------------------------------- finding the programs

export interface FindIO {
  home: string;
  /** the directories of PATH */
  pathDirs: string[];
  isFile: (path: string) => Promise<boolean>;
  /** the names in a folder (none when it is not there) */
  list: (dir: string) => Promise<string[]>;
}

const MODEL_NAME = /^ggml-(tiny|base|small|medium|large)(?!.*(?:encoder|vad|silero))[\w.-]*\.bin$/;
/** The model to prefer when several are there: small is the best compromise on a CPU, then the bigger, then the
 *  smaller; an English-only model (`.en`) is the last choice, it cannot transcribe Italian. */
const MODEL_ORDER = ["small", "base", "medium", "tiny", "large"];

/** Pure: the models among some file names, best first (multilingual before English-only, then by size order, and
 *  a quantised one after the full one of the same size). Vad, encoder and test files are not models of ours. */
export function rankModels(paths: string[]): string[] {
  const score = (p: string) => {
    const name = p.split("/").pop()!;
    const size = name.match(MODEL_NAME)?.[1];
    if (!size) return null;
    const english = name.includes(".en") ? 100 : 0;
    const quant = /-q\d/.test(name) ? 1 : 0;
    return english + MODEL_ORDER.indexOf(size) * 2 + quant;
  };
  return paths.map((p) => [p, score(p)] as const).filter((x): x is readonly [string, number] => x[1] !== null)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map((x) => x[0]);
}

async function firstFile(io: FindIO, paths: string[]): Promise<string | null> {
  for (const p of paths) if (await io.isFile(p)) return p;
  return null;
}

/** The whisper.cpp command-line program: PATH, then the usual places a build leaves it. */
export async function findWhisperBin(io: FindIO): Promise<string | null> {
  const fromPath = io.pathDirs.flatMap((d) => ["whisper-cli", "whisper-cpp"].map((n) => `${d}/${n}`));
  const found = await firstFile(io, fromPath);
  if (found) return found;
  const src = [`${io.home}/.local/src/whisper.cpp`, "/opt/whisper.cpp", "/usr/local/src/whisper.cpp"];
  const builds: string[] = [];
  for (const root of src) {
    for (const n of (await io.list(root)).filter((n) => n === "build" || n.startsWith("build")).sort()) {
      builds.push(`${root}/${n}/bin/whisper-cli`);
    }
  }
  return await firstFile(io, builds);
}

/** A ggml model in the usual places: `~/.local/share/<anything>/models`, the source checkout's `models`. */
export async function findWhisperModel(io: FindIO): Promise<string | null> {
  const dirs = [
    `${io.home}/.local/src/whisper.cpp/models`,
    "/opt/whisper.cpp/models",
    "/usr/local/src/whisper.cpp/models",
  ];
  for (const n of await io.list(`${io.home}/.local/share`)) dirs.push(`${io.home}/.local/share/${n}/models`);
  dirs.push(`${io.home}/.local/share/whisper.cpp`);
  const all: string[] = [];
  for (const d of dirs) for (const n of await io.list(d)) if (MODEL_NAME.test(n)) all.push(`${d}/${n}`);
  for (const m of rankModels(all)) if (await io.isFile(m)) return m;
  return null;
}

export async function findOnPath(io: FindIO, name: string): Promise<string | null> {
  return await firstFile(io, io.pathDirs.map((d) => `${d}/${name}`));
}

/** The real machine, for the finders. */
export function realFindIO(): FindIO {
  return {
    home: HOME,
    pathDirs: (Deno.env.get("PATH") ?? "").split(":").filter(Boolean),
    isFile: async (p) => (await Deno.stat(p).catch(() => null))?.isFile ?? false,
    list: async (d) => {
      try {
        const out: string[] = [];
        for await (const e of Deno.readDir(d)) out.push(e.name);
        return out;
      } catch {
        return [];
      }
    },
  };
}

/** Pure: a configured path with its `~/` expanded. */
export const expandVoicePath = (p: string, home = HOME) => p.startsWith("~/") ? `${home}${p.slice(1)}` : p;

/** Whether this machine can take a voice turn: whisper and its model are where the setting says, and ffmpeg is on
 *  PATH. That is what the node announces. */
export async function voiceReady(voice: VoiceConfig | undefined, io: FindIO = realFindIO()): Promise<boolean> {
  if (!voice) return false;
  if (!voicePath(voice.bin) || !voicePath(voice.model)) return false;
  return (await io.isFile(expandVoicePath(voice.bin, io.home))) &&
    (await io.isFile(expandVoicePath(voice.model, io.home))) &&
    !!(await findOnPath(io, "ffmpeg"));
}

// ---------------------------------------------------------------- running them

/** Pure: a name for the audio file by its type, so ffmpeg is not left guessing from nothing. */
export function audioExt(type: string): string {
  const t = type.split(";")[0].trim().toLowerCase();
  if (t.includes("webm")) return "webm";
  if (t.includes("ogg")) return "ogg";
  if (t.includes("mpeg")) return "mp3";
  if (t.includes("wav")) return "wav";
  if (t.includes("aac")) return "aac";
  return "m4a"; // mp4 audio from iOS, x-m4a
}

/** Pure: ffmpeg's demuxer for a file of `audioExt`: the recording is read as what its type says, so a playlist or a
 *  concat list sent with an audio type is not followed. */
export function audioDemuxer(ext: string): string {
  return ({ webm: "matroska", ogg: "ogg", mp3: "mp3", wav: "wav", aac: "aac" } as Record<string, string>)[ext] ?? "mov";
}

/** Pure: ffmpeg's arguments: any input to 16 kHz mono 16-bit WAV, the format whisper.cpp reads. Local files only
 *  (`-protocol_whitelist file`), the container forced by its type. */
export function ffmpegArgs(
  input: string,
  output: string,
  demuxer = audioDemuxer(input.split(".").pop() ?? ""),
): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-protocol_whitelist",
    "file",
    "-f",
    demuxer,
    "-i",
    input,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    output,
  ];
}

/** Pure: whisper-cli's arguments: the model, the WAV, the language, text only (no timestamps, no progress). */
export function whisperArgs(model: string, wav: string, language: string): string[] {
  return ["-m", model, "-f", wav, "-l", language, "-nt", "-np"];
}

/** Pure: what whisper printed, cleaned: blank lines out, runs of spaces made one. Whisper marks silence and noise
 *  with bracketed words ([BLANK_AUDIO]) or parenthesised ones ((music)); a text made only of those is empty. */
export function cleanTranscript(out: string): string {
  const text = out.split("\n").map((l) => l.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
  const speech = text.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  return speech.replace(/\([^)]*\)|♪/g, "").trim() ? speech : "";
}

export interface VoiceSetup {
  cfg: VoiceConfig;
  /** whisper's language code */
  language: string;
  /** a node with the sandbox tool runs both programs with no network; given the temporary folder, the one place they
   *  write */
  confine?: (tmp: string) => Wrap;
}
type Wrap = (cmd: string, args: string[]) => { cmd: string; args: string[] };

/** Pure: the sandbox tool's wrapper (bubblewrap): the same filesystem, read only but for the temporary folder, no
 *  network, its own processes, and gone with the node's process (a cancelled note stops the program, not only the
 *  wrapper). */
export function confineWith(bwrap: string, tmp: string) {
  return (cmd: string, args: string[]) => ({
    cmd: bwrap,
    args: [
      "--unshare-net",
      "--unshare-pid",
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--bind",
      tmp,
      tmp,
      "--",
      cmd,
      ...args,
    ],
  });
}

export const TRANSCRIBE_MS = 30 * 60_000;

/** One voice note to text: the temporary folder is made and removed here, whatever happens. Throws with what went
 *  wrong (the turn then ends with it). An empty result is a note with no speech in it: "" . */
export async function transcribeAudio(
  audio: { type: string; data: Uint8Array },
  setup: VoiceSetup,
  io: VoiceIO,
  signal?: AbortSignal,
): Promise<string> {
  const dir = await io.tempDir();
  try {
    const input = `${dir}/note.${audioExt(audio.type)}`, wav = `${dir}/note.wav`;
    await io.write(input, audio.data);
    const wrap: Wrap = setup.confine?.(dir) ?? ((cmd, args) => ({ cmd, args }));
    // a note is five minutes at most: half an hour is a program that hangs
    signal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(TRANSCRIBE_MS)])
      : AbortSignal.timeout(TRANSCRIBE_MS);
    const f = wrap("ffmpeg", ffmpegArgs(input, wav));
    const conv = await io.run(f.cmd, f.args, { signal });
    if (conv.code !== 0) throw new Error(`ffmpeg could not read the recording: ${conv.stderr.trim().slice(-300)}`);
    const w = wrap(setup.cfg.bin, whisperArgs(setup.cfg.model, wav, setup.language));
    const r = await io.run(w.cmd, w.args, { signal });
    if (r.code !== 0) throw new Error(`whisper failed: ${r.stderr.trim().slice(-300)}`);
    return cleanTranscript(r.stdout);
  } finally {
    await io.remove(dir).catch(() => {});
  }
}

/** The real programs: an empty environment but PATH and a UTF-8 locale. */
export function realVoiceIO(): VoiceIO {
  return {
    run: async (cmd, args, o) => {
      const r = await new Deno.Command(cmd, {
        args,
        clearEnv: true,
        env: { PATH: Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal: o?.signal,
      }).output();
      const dec = new TextDecoder();
      return { code: r.code, stdout: dec.decode(r.stdout), stderr: dec.decode(r.stderr) };
    },
    tempDir: () => Deno.makeTempDir({ prefix: "agents-voice-" }),
    write: (path, data) => Deno.writeFile(path, data, { mode: 0o600 }),
    remove: (dir) => Deno.remove(dir, { recursive: true }),
  };
}

/** A transcriber for a node: the settings are read each time (`agents node voice` takes effect without a restart).
 *  `confined`: this node is headless, so the sandbox tool (when present) takes the network away. */
export function realTranscriber(
  cfg: () => Promise<{ voice?: VoiceConfig; headless: boolean }>,
  io: VoiceIO = realVoiceIO(),
  find: FindIO = realFindIO(),
): (audio: { type: string; data: Uint8Array }, signal?: AbortSignal) => Promise<string> {
  return async (audio, signal) => {
    const c = await cfg();
    if (!c.voice) throw new Error("this machine has no voice setup (agents node voice)");
    const bwrap = c.headless ? await findOnPath(find, "bwrap") : null;
    return await transcribeAudio(
      audio,
      {
        cfg: { bin: expandVoicePath(c.voice.bin), model: expandVoicePath(c.voice.model) },
        language: whisperLanguage(owner().language),
        ...(bwrap ? { confine: (tmp: string) => confineWith(bwrap, tmp) } : {}),
      },
      io,
      signal,
    );
  };
}

// ---------------------------------------------------------------- the model, downloaded once

/** Models `agents node setup` offers: ggerganov/whisper.cpp on Hugging Face, with the SHA-256 of each file (the
 *  LFS pointer's own). Multilingual ones only: the account may speak any language. */
export const MODELS = [
  {
    name: "base",
    file: "ggml-base.bin",
    bytes: 147_951_465,
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    note: "fast on a small server, fair on Italian",
  },
  {
    name: "small",
    file: "ggml-small.bin",
    bytes: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    note: "better with accents and names, about three times slower",
  },
] as const;

export const modelUrl = (file: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;
/** Where a downloaded model goes: a folder the finder looks in. */
export const modelDir = (home = HOME) => `${home}/.local/share/whisper.cpp/models`;

/** Downloads a model to `dest` and keeps it only when its SHA-256 is the expected one (the file is written aside and
 *  moved into place). `fetcher` and `hash` are the real ones unless a test passes its own. */
export async function downloadModel(
  m: { file: string; sha256: string },
  dest: string,
  o: {
    fetcher?: typeof fetch;
    progress?: (done: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ ok: true } | { ok: false; why: string }> {
  const { createHash } = await import("node:crypto");
  const tmp = `${dest}.part`;
  await Deno.mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
  const r = await (o.fetcher ?? fetch)(modelUrl(m.file), { signal: o.signal, redirect: "follow" }).catch((e) =>
    e as Error
  );
  if (r instanceof Error) return { ok: false, why: `the download failed: ${r.message}` };
  if (!r.ok || !r.body) return { ok: false, why: `the download failed: HTTP ${r.status}` };
  const hash = createHash("sha256");
  const file = await Deno.open(tmp, { write: true, create: true, truncate: true, mode: 0o644 });
  let done = 0;
  try {
    for await (const chunk of r.body) {
      hash.update(chunk);
      await file.write(chunk);
      done += chunk.byteLength;
      o.progress?.(done);
    }
  } catch (e) {
    file.close();
    await Deno.remove(tmp).catch(() => {});
    return { ok: false, why: `the download failed: ${(e as Error).message}` };
  }
  file.close();
  const got = hash.digest("hex");
  if (got !== m.sha256) {
    await Deno.remove(tmp).catch(() => {});
    return {
      ok: false,
      why: `the checksum does not match (got ${got.slice(0, 12)}…, expected ${
        m.sha256.slice(0, 12)
      }…): the file was removed`,
    };
  }
  await Deno.rename(tmp, dest);
  return { ok: true };
}
