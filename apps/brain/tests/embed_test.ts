// Tests for the calls to the embedding model (embed.ts): a search does not wait on a model that
// hangs, and an answer comes back as vectors.
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { embed } from "../embed.ts";

const PORT = 8789;

Deno.test("embed: a model that does not answer is given up on at the deadline", async () => {
  const hang = Promise.withResolvers<void>();
  const server = Deno.serve({ port: PORT, hostname: "127.0.0.1", onListen() {} }, async () => {
    await hang.promise;
    return new Response("{}");
  });
  try {
    const t0 = Date.now();
    await assertRejects(() => embed({ url: `http://127.0.0.1:${PORT}`, model: "m" }, ["q"], 200));
    assertEquals(Date.now() - t0 < 2_000, true, "gave up near the deadline, not after minutes");
  } finally {
    hang.resolve();
    await server.shutdown();
  }
});

Deno.test("embed: the vectors of every input, from one request", async () => {
  let calls = 0;
  const server = Deno.serve({ port: PORT, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    calls++;
    const { input } = await req.json() as { input: string[] };
    return Response.json({ embeddings: input.map((_, i) => [i, 1]) });
  });
  try {
    assertEquals(await embed({ url: `http://127.0.0.1:${PORT}`, model: "m" }, ["a", "b"]), [[0, 1], [1, 1]]);
    assertEquals(calls, 1);
  } finally {
    await server.shutdown();
  }
});
