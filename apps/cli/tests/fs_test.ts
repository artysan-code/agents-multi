// Tests for shared/mcp/lib/fs.ts: the atomic write and its modes, the null-reading JSON, the serial queue.
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { readJson, serializer, writeAtomic } from "../../../shared/mcp/lib/fs.ts";

Deno.test("writeAtomic: writes text and bytes, replaces, leaves no temporary file, honours the mode", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeAtomic(`${dir}/a.json`, "one");
    await writeAtomic(`${dir}/a.json`, "two");
    assertEquals(await Deno.readTextFile(`${dir}/a.json`), "two");
    await writeAtomic(`${dir}/b.bin`, new Uint8Array([1, 2, 3]));
    assertEquals([...await Deno.readFile(`${dir}/b.bin`)], [1, 2, 3]);
    await writeAtomic(`${dir}/secret`, "x", { mode: 0o600 });
    assertEquals((await Deno.stat(`${dir}/secret`)).mode! & 0o777, 0o600);
    await writeAtomic(`${dir}/secret`, "y", { mode: 0o640 });
    assertEquals((await Deno.stat(`${dir}/secret`)).mode! & 0o777, 0o640);
    assertEquals((await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name).sort(), ["a.json", "b.bin", "secret"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeAtomic: a failed write leaves no temporary file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/target`); // renaming a file over a directory fails
    await assertRejects(() => writeAtomic(`${dir}/target`, "x"));
    assertEquals((await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name), ["target"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readJson: null for a missing or broken file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/ok.json`, '{"a":1}');
    await Deno.writeTextFile(`${dir}/bad.json`, "{");
    assertEquals(await readJson(`${dir}/ok.json`), { a: 1 });
    assertEquals(await readJson(`${dir}/bad.json`), null);
    assertEquals(await readJson(`${dir}/none.json`), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("serializer: jobs run one at a time, in order, and a failure does not stop the queue", async () => {
  const serial = serializer();
  const log: string[] = [];
  const job = (name: string, ms: number, fail = false) => () =>
    new Promise<string>((res, rej) => {
      log.push(`start ${name}`);
      setTimeout(() => {
        log.push(`end ${name}`);
        fail ? rej(new Error(name)) : res(name);
      }, ms);
    });
  const results = await Promise.allSettled([serial(job("a", 20)), serial(job("b", 1, true)), serial(job("c", 1))]);
  assertEquals(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  assertEquals(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
});
