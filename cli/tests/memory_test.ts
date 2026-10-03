// Tests for memory.ts: which console requests reach the brain, and with what.
import { assertEquals } from "jsr:@std/assert@1";
import { upstream } from "../memory.ts";

Deno.test("upstream: only the reads, only their parameters, on the brain's address", () => {
  const u = (s: string) => new URL(`http://127.0.0.1:7331${s}`);
  assertEquals(upstream("https://brain.example/", u("/api/brain/pages")), "https://brain.example/api/brain/pages");
  assertEquals(upstream("https://brain.example", u("/api/brain/page?path=io/chi-sono.md&rev=2&x=1")), "https://brain.example/api/brain/page?path=io%2Fchi-sono.md&rev=2");
  assertEquals(upstream("https://brain.example", u("/api/brain/search?q=ciao mondo")), "https://brain.example/api/brain/search?q=ciao+mondo");
  assertEquals(upstream("https://brain.example", u("/api/brain/state")), null);
  assertEquals(upstream("https://brain.example", u("/api/tasks")), null);
});
