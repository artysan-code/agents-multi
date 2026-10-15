// Tests for a node taking voice notes (ADR 0014, second round): the language mapping, finding whisper.cpp and a
// model, the transcription with a fake ffmpeg and a fake whisper, the model download and its checksum, the
// settings in node.json, and the turn loop's voice and cancel paths against a fake service.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { cleanNodeConfig, mergeNodeConfig, voicePath } from "../../../shared/mcp/lib/headless.ts";
import { voiceConfigWith } from "../node/command.ts";
import {
  audioExt,
  cleanTranscript,
  confineWith,
  downloadModel,
  ffmpegArgs,
  type FindIO,
  findOnPath,
  findWhisperBin,
  findWhisperModel,
  rankModels,
  transcribeAudio,
  type VoiceIO,
  voiceReady,
  whisperArgs,
  whisperLanguage,
} from "../node/voice.ts";
import { answerTurn, type Claimed, type Piece, type Runner } from "../node/turns.ts";
import { type Service, ServiceError } from "../node/service.ts";

Deno.test("whisperLanguage: names, codes and regional codes map to a two-letter code, the rest to auto", () => {
  for (
    const [name, code] of [
      ["Italian", "it"],
      ["italiano", "it"],
      ["  English ", "en"],
      ["en", "en"],
      ["pt-BR", "pt"],
      ["pt_br", "pt"],
      ["Français", "fr"],
      ["Español", "es"],
      ["Deutsch", "de"],
      ["IT", "it"],
      ["Klingon", "auto"],
      ["", "auto"],
      ["xx", "auto"],
      [undefined, "auto"],
    ] as const
  ) assertEquals(whisperLanguage(name), code, String(name));
});

const fakeFind = (
  files: string[],
  dirs: Record<string, string[]> = {},
  home = "/home/me",
  pathDirs = ["/usr/bin"],
): FindIO => ({
  home,
  pathDirs,
  isFile: (p) => Promise.resolve(files.includes(p)),
  list: (d) => Promise.resolve(dirs[d] ?? []),
});

Deno.test("rankModels: a multilingual small first, English-only last, vad and encoder files never", () => {
  const all = [
    "/m/ggml-base.en.bin",
    "/m/ggml-tiny.bin",
    "/m/ggml-small.bin",
    "/m/ggml-small-q5_1.bin",
    "/m/ggml-base.bin",
    "/m/ggml-silero-v5.1.2.bin",
    "/m/ggml-small-encoder.mlmodelc.bin",
    "/m/for-tests-ggml-base.bin",
    "/m/readme.md",
  ];
  assertEquals(rankModels(all), [
    "/m/ggml-small.bin",
    "/m/ggml-small-q5_1.bin",
    "/m/ggml-base.bin",
    "/m/ggml-tiny.bin",
    "/m/ggml-base.en.bin",
  ]);
  const r = rankModels(all);
  assertEquals(r.indexOf("/m/ggml-small.bin") < r.indexOf("/m/ggml-small-q5_1.bin"), true);
  assertEquals(r.indexOf("/m/ggml-small-q5_1.bin") < r.indexOf("/m/ggml-base.bin"), true);
  assertEquals(r[r.length - 1], "/m/ggml-base.en.bin");
  assert(!r.some((p) => p.includes("silero") || p.includes("for-tests") || p.endsWith(".md")));
});

Deno.test("findWhisperBin: PATH first, then the usual builds; findWhisperModel: the usual folders, best model first", async () => {
  assertEquals(await findWhisperBin(fakeFind(["/usr/bin/whisper-cli"])), "/usr/bin/whisper-cli");
  const src = "/home/me/.local/src/whisper.cpp";
  const built = fakeFind([`${src}/build-cpu/bin/whisper-cli`], { [src]: ["build-cpu", "models", "README.md"] });
  assertEquals(await findWhisperBin(built), `${src}/build-cpu/bin/whisper-cli`);
  assertEquals(await findWhisperBin(fakeFind([])), null);

  const share = "/home/me/.local/share";
  const m = fakeFind(
    [
      `${share}/whisper.cpp/models/ggml-base.bin`,
      `${share}/other/models/ggml-small.bin`,
      `${src}/models/ggml-tiny.bin`,
    ],
    {
      [share]: ["whisper.cpp", "other", "applications"],
      [`${share}/whisper.cpp/models`]: ["ggml-base.bin", "notes.txt"],
      [`${share}/other/models`]: ["ggml-small.bin"],
      [`${src}/models`]: ["ggml-tiny.bin"],
    },
  );
  assertEquals(await findWhisperModel(m), `${share}/other/models/ggml-small.bin`);
  assertEquals(await findWhisperModel(fakeFind([])), null);
  // a name that is listed but not a file is not taken
  assertEquals(
    await findWhisperModel(fakeFind([], { [`${share}/x/models`]: ["ggml-base.bin"], [share]: ["x"] })),
    null,
  );
  assertEquals(await findOnPath(fakeFind(["/usr/bin/ffmpeg"]), "ffmpeg"), "/usr/bin/ffmpeg");
});

Deno.test("voiceReady: both files and ffmpeg, else no", async () => {
  const v = { bin: "~/w/whisper-cli", model: "/m/ggml-base.bin" };
  const files = ["/home/me/w/whisper-cli", "/m/ggml-base.bin", "/usr/bin/ffmpeg"];
  assertEquals(await voiceReady(v, fakeFind(files)), true);
  assertEquals(await voiceReady(v, fakeFind(files.slice(0, 2))), false); // no ffmpeg
  assertEquals(await voiceReady(v, fakeFind([files[0], files[2]])), false); // no model
  assertEquals(await voiceReady(undefined, fakeFind(files)), false);
  assertEquals(await voiceReady({ bin: "relative", model: "/m/x" }, fakeFind(files)), false);
});

Deno.test("node.json: voice is a machine field, kept only with two valid paths", () => {
  assertEquals(voicePath("/opt/w/whisper-cli"), "/opt/w/whisper-cli");
  assertEquals(voicePath("~/w/whisper-cli"), "~/w/whisper-cli");
  for (const bad of ["whisper-cli", "/a/../b", "/a\nb", "", 7, null, "x".repeat(600)]) {
    assertEquals(voicePath(bad), null, String(bad));
  }
  assertEquals(cleanNodeConfig({ voice: { bin: "/b", model: "/m.bin" } }).voice, { bin: "/b", model: "/m.bin" });
  assertEquals(cleanNodeConfig({ voice: { bin: "/b" } }).voice, undefined);
  assertEquals(cleanNodeConfig({ voice: { bin: "b", model: "/m" } }).voice, undefined);
  // the owner's synced file never sets it for every machine; this machine's file does
  assertEquals(mergeNodeConfig({ voice: { bin: "/x", model: "/y" } }, {}).voice, undefined);
  assertEquals(mergeNodeConfig({}, { voice: { bin: "/x", model: "/y" } }).voice, { bin: "/x", model: "/y" });
  // writing it keeps the other keys; null removes it
  const on = voiceConfigWith({ enabled: true, name: "desk" }, { bin: "/x", model: "/y" });
  assertEquals(on, { enabled: true, name: "desk", voice: { bin: "/x", model: "/y" } });
  assertEquals(voiceConfigWith(on, null), { enabled: true, name: "desk" });
  assertEquals(voiceConfigWith(null, null), {});
});

Deno.test("audio to text: the arguments, the extension by type, the cleaned transcript", () => {
  assertEquals(audioExt("audio/webm;codecs=opus"), "webm");
  assertEquals(audioExt("audio/mp4"), "m4a");
  assertEquals(audioExt("audio/ogg"), "ogg");
  assertEquals(audioExt("audio/mpeg"), "mp3");
  const f = ffmpegArgs("/t/in.webm", "/t/out.wav");
  assertEquals(f.slice(-9), ["-i", "/t/in.webm", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "/t/out.wav"]);
  assert(f.includes("-nostdin"));
  assertEquals(whisperArgs("/m.bin", "/t/out.wav", "it"), [
    "-m",
    "/m.bin",
    "-f",
    "/t/out.wav",
    "-l",
    "it",
    "-nt",
    "-np",
  ]);
  assertEquals(cleanTranscript("  Ciao   a tutti\n\n e buona giornata \n"), "Ciao a tutti e buona giornata");
  assertEquals(cleanTranscript(" [BLANK_AUDIO]\n"), "");
  assertEquals(cleanTranscript("(musica)\n"), "");
  assertEquals(cleanTranscript("[BLANK_AUDIO] Ciao"), "Ciao");
  assertEquals(cleanTranscript(""), "");
  assertEquals(confineWith("/usr/bin/bwrap", "/t")("whisper-cli", ["-m", "x"]), {
    cmd: "/usr/bin/bwrap",
    args: [
      "--unshare-net",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--bind",
      "/t",
      "/t",
      "--",
      "whisper-cli",
      "-m",
      "x",
    ],
  });
});

function fakeIO(script: (cmd: string, args: string[]) => { code: number; stdout?: string; stderr?: string }) {
  const calls: { cmd: string; args: string[] }[] = [];
  const written: Record<string, number> = {};
  const removed: string[] = [];
  const io: VoiceIO = {
    run: (cmd, args) => {
      calls.push({ cmd, args });
      const r = script(cmd, args);
      return Promise.resolve({ code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
    },
    tempDir: () => Promise.resolve("/tmp/agents-voice-1"),
    write: (p, d) => ((written[p] = d.byteLength), Promise.resolve()),
    remove: (d) => (removed.push(d), Promise.resolve()),
  };
  return { io, calls, written, removed };
}

const setup = { cfg: { bin: "/w/whisper-cli", model: "/m/ggml-base.bin" }, language: "it" };

Deno.test("transcribeAudio: ffmpeg to WAV, then whisper in the account's language; the temp folder always goes", async () => {
  const f = fakeIO((cmd) => cmd === "ffmpeg" ? { code: 0 } : { code: 0, stdout: "\n Ricordami di chiamare Anna.\n" });
  const text = await transcribeAudio({ type: "audio/webm;codecs=opus", data: new Uint8Array(5) }, setup, f.io);
  assertEquals(text, "Ricordami di chiamare Anna.");
  assertEquals(f.written, { "/tmp/agents-voice-1/note.webm": 5 });
  assertEquals(f.calls.map((c) => c.cmd), ["ffmpeg", "/w/whisper-cli"]);
  assertEquals(f.calls[0].args.at(-1), "/tmp/agents-voice-1/note.wav");
  assertEquals(f.calls[1].args, whisperArgs("/m/ggml-base.bin", "/tmp/agents-voice-1/note.wav", "it"));
  assertEquals(f.removed, ["/tmp/agents-voice-1"]);
});

Deno.test("transcribeAudio: on a confined node whisper runs inside the wrapper; a failing program fails the note and cleans up", async () => {
  const f = fakeIO(() => ({ code: 0, stdout: "ok" }));
  await transcribeAudio({ type: "audio/mp4", data: new Uint8Array(1) }, {
    ...setup,
    confine: (t) => confineWith("/usr/bin/bwrap", t),
  }, f.io);
  assertEquals(f.calls[0].cmd, "ffmpeg"); // the converter reads a recording, it is not confined
  assertEquals(f.calls[1].cmd, "/usr/bin/bwrap");
  assertEquals(f.calls[1].args.slice(0, 2), ["--unshare-net", "--ro-bind"]);
  assert(f.calls[1].args.includes("--bind") && f.calls[1].args.includes("/w/whisper-cli"));

  const bad = fakeIO((cmd) => cmd === "ffmpeg" ? { code: 1, stderr: "Invalid data found" } : { code: 0 });
  await assertRejects(
    () => transcribeAudio({ type: "audio/webm", data: new Uint8Array(1) }, setup, bad.io),
    Error,
    "ffmpeg could not read",
  );
  assertEquals(bad.removed, ["/tmp/agents-voice-1"]);
  assertEquals(bad.calls.length, 1);
  const w = fakeIO((cmd) => cmd === "ffmpeg" ? { code: 0 } : { code: 3, stderr: "bad model" });
  await assertRejects(
    () => transcribeAudio({ type: "audio/webm", data: new Uint8Array(1) }, setup, w.io),
    Error,
    "whisper failed: bad model",
  );
  assertEquals(w.removed.length, 1);
  // nothing heard is an empty text, not an error: the turn loop says so
  const quiet = fakeIO((cmd) => cmd === "ffmpeg" ? { code: 0 } : { code: 0, stdout: "[BLANK_AUDIO]\n" });
  assertEquals(await transcribeAudio({ type: "audio/webm", data: new Uint8Array(1) }, setup, quiet.io), "");
});

const bytes = (...n: number[]) => new Uint8Array(n);

Deno.test("downloadModel: the file is kept when its SHA-256 is the expected one, removed when it is not", async () => {
  const dir = await Deno.makeTempDir({ prefix: "model-test-" });
  try {
    const data = bytes(1, 2, 3, 4, 5);
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) =>
      b.toString(16).padStart(2, "0")
    ).join("");
    const urls: string[] = [];
    const fetcher = ((u: string) => (urls.push(u), Promise.resolve(new Response(data)))) as unknown as typeof fetch;
    const ok = await downloadModel({ file: "ggml-base.bin", sha256: sha }, `${dir}/m/ggml-base.bin`, { fetcher });
    assertEquals(ok, { ok: true });
    assertEquals(urls, ["https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"]);
    assertEquals([...await Deno.readFile(`${dir}/m/ggml-base.bin`)], [1, 2, 3, 4, 5]);
    assertEquals((await Array.fromAsync(Deno.readDir(`${dir}/m`))).map((e) => e.name), ["ggml-base.bin"]);

    const bad = await downloadModel({ file: "ggml-small.bin", sha256: "00".repeat(32) }, `${dir}/m/ggml-small.bin`, {
      fetcher,
    });
    assert(!bad.ok && bad.why.includes("checksum does not match"));
    assertEquals((await Array.fromAsync(Deno.readDir(`${dir}/m`))).map((e) => e.name), ["ggml-base.bin"]); // nothing left behind
    const down = await downloadModel({ file: "x.bin", sha256: sha }, `${dir}/m/x.bin`, {
      fetcher: (() => Promise.resolve(new Response("no", { status: 503 }))) as unknown as typeof fetch,
    });
    assert(!down.ok && down.why.includes("HTTP 503"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------- the turn loop's voice and cancel paths

const vturn = (id = "v1"): Claimed => ({ id, chat: "c1", text: "", session: null, history: [], voice: true });

function fakeSvc(opts: { cancelOn?: (path: string, n: number) => boolean; audio?: boolean } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let n = 0;
  const svc: Service = {
    url: "https://svc",
    call<T>(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      if (opts.cancelOn?.(path, ++n)) {
        return Promise.reject(
          new ServiceError(`${method} ${path}: the turn was cancelled`, 409, {
            cancelled: true,
            error: "the turn was cancelled",
          }),
        );
      }
      return Promise.resolve({ ok: true } as T);
    },
    ...(opts.audio === false ? {} : {
      bytes: (path: string) => {
        calls.push({ method: "GET", path });
        return Promise.resolve({ type: "audio/webm", data: bytes(7, 7, 7) });
      },
    }),
  };
  return { svc, calls };
}

const text = (d: string): Piece => ({ t: "text", d });

Deno.test("answerTurn: a voice turn is fetched, transcribed, its transcript is the first event, then the text is answered", async () => {
  const f = fakeSvc();
  let heard: { type: string; n: number } | null = null;
  const asked: string[] = [];
  const run: Runner = (t, _o, onEvent) => {
    asked.push(t);
    onEvent(text("Fatto."));
    return Promise.resolve({ t: "done", text: "Fatto.", code: null });
  };
  const r = await answerTurn(f.svc, vturn(), run, new AbortController().signal, 5, 1000, (a) => {
    heard = { type: a.type, n: a.data.length };
    return Promise.resolve("ricordami di chiamare Anna");
  });
  assertEquals(r, {});
  assertEquals(heard, { type: "audio/webm", n: 3 });
  assertEquals(asked, ["ricordami di chiamare Anna"]);
  const paths = f.calls.map((c) => `${c.method} ${c.path}`);
  assertEquals(paths.slice(0, 2), ["GET /api/turns/v1/audio", "POST /api/turns/v1/events"]);
  assertEquals((f.calls[1].body as { events: unknown[] }).events, [{
    t: "transcript",
    text: "ricordami di chiamare Anna",
  }]);
  assert(paths.indexOf("POST /api/turns/v1/done") > 1);
  assertEquals(f.calls.find((c) => c.path.endsWith("/done"))!.body, { text: "Fatto." });
});

Deno.test("answerTurn: nothing heard, a failed transcription, or no way to transcribe ends the turn with the reason, no run", async () => {
  for (
    const [transcribe, why] of [
      [() => Promise.resolve("  "), "no speech was heard"],
      [() => Promise.reject(new Error("whisper failed: bad model")), "whisper failed: bad model"],
      [undefined, "cannot transcribe"],
    ] as const
  ) {
    const f = fakeSvc();
    let ran = 0;
    const r = await answerTurn(
      f.svc,
      vturn(),
      () => (ran++, Promise.resolve({ t: "done", text: "", code: null })),
      new AbortController().signal,
      5,
      1000,
      transcribe,
    );
    assert(r.error?.includes(why), `${r.error}`);
    assertEquals(ran, 0);
    const done = f.calls.find((c) => c.path.endsWith("/done"))!.body as { error: string };
    assert(done.error.includes(why));
  }
  const f = fakeSvc({ audio: false });
  const r = await answerTurn(
    f.svc,
    vturn(),
    () => Promise.resolve({ t: "done", text: "", code: null }),
    new AbortController().signal,
    5,
    1000,
    () => Promise.resolve("x"),
  );
  assert(r.error?.includes("cannot fetch audio"));
});

Deno.test("answerTurn: a 409 cancelled on an events post aborts the run and ends the turn without reporting it", async () => {
  const f = fakeSvc({ cancelOn: (p) => p.endsWith("/events") });
  let aborted = false;
  const run: Runner = (_t, o, onEvent) => {
    onEvent(text("working"));
    return new Promise((res) => {
      o.signal!.addEventListener("abort", () => {
        aborted = true;
        res({ t: "done", text: "working", code: null, error: "aborted" });
      });
    });
  };
  const r = await answerTurn(
    f.svc,
    { ...vturn("t1"), voice: undefined, text: "go" },
    run,
    new AbortController().signal,
    5,
    1000,
  );
  assertEquals(r, { cancelled: true });
  assert(aborted);
  assert(!f.calls.some((c) => c.path.endsWith("/done")), "a cancelled turn is not reported");
});

Deno.test("answerTurn: a heartbeat answered cancelled stops a silent run, and so does a cancelled done", async () => {
  const f = fakeSvc({ cancelOn: (p, n) => p.endsWith("/events") && n >= 2 });
  const run: Runner = (_t, o) =>
    new Promise((res) => {
      o.signal!.addEventListener("abort", () => res({ t: "done", text: "", code: null, error: "aborted" }));
    });
  const r = await answerTurn(
    f.svc,
    { ...vturn("t2"), voice: undefined, text: "go" },
    run,
    new AbortController().signal,
    5,
    20,
  );
  assertEquals(r, { cancelled: true });

  const g = fakeSvc({ cancelOn: (p) => p.endsWith("/done") });
  const done = await answerTurn(
    g.svc,
    { ...vturn("t3"), voice: undefined, text: "go" },
    () => Promise.resolve({ t: "done", text: "x", code: null }),
    new AbortController().signal,
    5,
    1000,
  );
  assertEquals(done, { cancelled: true });
  assertEquals(g.calls.filter((c) => c.path.endsWith("/done")).length, 1); // told once, not retried
});

Deno.test("ServiceError: carries the status and body; only a 409 with cancelled is a cancel", async () => {
  const { isCancelled } = await import("../node/service.ts");
  assert(isCancelled(new ServiceError("x", 409, { cancelled: true })));
  assert(!isCancelled(new ServiceError("x", 409, {})));
  assert(!isCancelled(new ServiceError("x", 500, { cancelled: true })));
  assert(!isCancelled(new Error("x")));
});
