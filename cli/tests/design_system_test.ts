// Tests for scripts/design-system.ts: the console's colours and stylesheet as the design system's.
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { bundleCss, consoleColours, cssVars, syncColours } from "../../scripts/design-system.ts";

const CSS = `@font-face { font-family: "X"; }
:root {
  --accent: #ad4e2c;
  --fg: #0b0b0b;
}
:root[data-theme="dark"] {
  --accent: #d97757;
  --fg: #f0efec;
}
* {
  box-sizing: border-box;
}
html,
body {
  height: 100%;
  overflow: hidden;
}
/* one colour per area of the brain */
:root {
  --g-io: #c6613f;
}
:root[data-theme="dark"] {
  --g-io: #e3845b;
}
.md {
  padding: 0;
}
`;

Deno.test("consoleColours: both themes, the brain's areas too", () => {
  assertEquals(cssVars(CSS, "\n:root").accent, "#ad4e2c");
  assertEquals(consoleColours(CSS), {
    light: { accent: "#ad4e2c", fg: "#0b0b0b", "g-io": "#c6613f" },
    dark: { accent: "#d97757", fg: "#f0efec", "g-io": "#e3845b" },
  });
});

Deno.test("bundleCss: no font faces, token blocks or full-window shell; the families mapped", () => {
  const b = bundleCss(CSS);
  assertEquals(b.includes("@font-face {") || b.includes("--g-io") || b.includes("overflow: hidden"), false);
  assertEquals(b.includes("--sans: var(--font-sans)") && b.includes("box-sizing") && b.includes(".md {"), true);
  assertThrows(() => bundleCss(CSS.replace(".md {", ".md { content: '</style>'; }\n.x {")));
});

Deno.test("syncColours: values from the console, notes kept, what changed listed", () => {
  const tokens = {
    color: {
      tokens: [{ name: "accent", value: { light: "#c6613f", dark: "#d97757" }, usage: "kept" }, {
        name: "fg",
        value: { light: "#0b0b0b", dark: "#f0efec" },
      }],
    },
  };
  assertEquals(syncColours(tokens, consoleColours(CSS)), ["accent: #c6613f/#d97757 → #ad4e2c/#d97757"]);
  assertEquals(tokens.color.tokens[0], { name: "accent", value: { light: "#ad4e2c", dark: "#d97757" }, usage: "kept" });
});
