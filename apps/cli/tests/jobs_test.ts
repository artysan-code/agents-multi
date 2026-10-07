// Tests for the console's streamed jobs: output as it is written, one job at a time per action, cancel.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { cancelJob, jobStream, spawnJob } from "../console/jobs.ts";

const sh = (script: string) => ({ cmd: "sh", args: ["-c", script] });
const lines = async (id: string) => {
  const text = await jobStream(id)!.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

Deno.test("jobs: the output streams in order and ends with the exit code", async () => {
  let done = 0;
  const { id } = spawnJob("t-out", sh("echo one; echo two >&2; exit 3"), 5000, {}, () => done++);
  const got = await lines(id);
  assertEquals(got.filter((l) => l.o).map((l) => l.o).join("").split("\n").filter(Boolean).sort(), ["one", "two"]);
  assertEquals(got.at(-1).done, 3);
  assertEquals(done, 1);
  // a late reader still gets the whole output
  assertEquals((await lines(id)).at(-1).done, 3);
});

Deno.test("jobs: a second start of the same action joins the one running; cancel stops it", async () => {
  const a = spawnJob("t-long", sh("echo start; sleep 30"), 60000, {}, () => {});
  const b = spawnJob("t-long", sh("echo other"), 60000, {}, () => {});
  assertEquals([b.id, b.running], [a.id, true]);
  assert(cancelJob(a.id));
  const got = await lines(a.id);
  assertEquals(got.at(-1).cancelled, true);
  assert(got.at(-1).done !== 0);
  assert(!cancelJob(a.id), "nothing left to cancel");
  assert(!cancelJob("no-such-job"));
  assertEquals(jobStream("no-such-job"), null);
});
