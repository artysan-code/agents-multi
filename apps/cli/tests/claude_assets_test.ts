// Tests for apps/cli/claude-assets.ts: Claude Desktop's faces, found by what the files say rather than
// by their hashed names.
import { assertEquals } from "jsr:@std/assert@1";
import { facesIn } from "../claude-assets.ts";

Deno.test("facesIn: only Anthropic's families, with their style", () => {
  const css = `@font-face{font-family:anthropic-sans;src:url(/assets/v1/a.woff2) format("woff2");font-style:italic}` +
    `@font-face{font-family:"KaTeX_Main";src:url(k.woff2)}` +
    `@font-face{font-family:'Anthropicons-Variable';src:url('/assets/v1/i.woff2')}`;
  assertEquals(facesIn(css), [
    { family: "anthropic-sans", style: "italic", url: "/assets/v1/a.woff2" },
  ]);
});
