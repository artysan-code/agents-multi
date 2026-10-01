// Tests for cli/claude-assets.ts: Claude Desktop's faces, spark animations and icons, found by
// what the files say rather than by their hashed names.
import { assertEquals } from "jsr:@std/assert@1";
import { facesIn, iconsIn, stripsIn } from "../claude-assets.ts";

Deno.test("facesIn: only Anthropic's families, with their style", () => {
  const css = `@font-face{font-family:anthropic-sans;src:url(/assets/v1/a.woff2) format("woff2");font-style:italic}` +
    `@font-face{font-family:"KaTeX_Main";src:url(k.woff2)}` +
    `@font-face{font-family:'Anthropicons-Variable';src:url('/assets/v1/i.woff2')}`;
  assertEquals(facesIn(css), [
    { family: "anthropic-sans", style: "italic", url: "/assets/v1/a.woff2" },
    { family: "Anthropicons-Variable", style: "normal", url: "/assets/v1/i.woff2" },
  ]);
});

Deno.test("stripsIn: each animation's frames, count and pace", () => {
  const js = `var e={thinking:{svg:'<svg viewBox="0 0 100 900"></svg>',width:100,height:100,frameCount:9,speed:90},` +
    `tickle:{svg:'<svg/>',width:100,height:100,frameCount:7,speed:40}};export{e as animations};`;
  assertEquals(stripsIn(js), {
    thinking: { svg: '<svg viewBox="0 0 100 900"></svg>', frameCount: 9, speed: 90 },
    tickle: { svg: "<svg/>", frameCount: 7, speed: 40 },
  });
});

Deno.test("iconsIn: the name to code point map, and nothing when it is not there", () => {
  assertEquals(iconsIn(`x;var ma={icons:{Activity:57344,Add:57345},secondary:{}}`), { Activity: 57344, Add: 57345 });
  assertEquals(iconsIn("var x=1"), {});
});
