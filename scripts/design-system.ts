// design-system.ts — keeps the console's design system (a claude.ai "Design System" artifact) the
// same as the console: its colours and its stylesheet come from apps/ui/src/styles/base.css.
//
//   deno run --allow-read --allow-write scripts/design-system.ts <dir>
//
// <dir> holds the artifact's files as read back from it (<dir>/project/tokens.json…). This updates
// every colour of project/tokens.json to the value style.css has in each theme (usage notes, type,
// spacing and the rest are the artifact's and stay), and rewrites project/components/bundle.css: the
// console's stylesheet without its @font-face, token blocks and full-window shell. Publishing the
// two files back to the artifact is a separate step (the Artifact tool).

const CSS = new URL("../apps/ui/src/styles/base.css", import.meta.url);

/** Pure: `--name: value;` of the first block opened by `selector`, as a map. */
export function cssVars(css: string, selector: string): Record<string, string> {
  const i = css.indexOf(`${selector} {`);
  if (i < 0) return {};
  const body = css.slice(i, css.indexOf("\n}", i));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/** Pure: the console's light and dark values of every colour, the brain's area colours included. */
export function consoleColours(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const areas = css.slice(css.indexOf("/* one colour per area"));
  return {
    light: { ...cssVars(css, "\n:root"), ...cssVars(areas, "\n:root") },
    dark: { ...cssVars(css, ':root[data-theme="dark"]'), ...cssVars(areas, ':root[data-theme="dark"]') },
  };
}

/** Pure: the console's stylesheet as the design system's bundle.css. */
export function bundleCss(css: string): string {
  let b = css.slice(css.indexOf("* {\n  box-sizing"));
  b = b.replace("html,\nbody {\n  height: 100%;\n  overflow: hidden;\n}\n", "");
  const a = b.indexOf("/* one colour per area"), z = b.indexOf(".md {", a);
  if (a >= 0 && z > a) b = b.slice(0, a) + b.slice(z);
  if (/<\/style/i.test(b)) throw new Error("style.css holds </style: it would end the preview's <style>");
  return "/* agents-multi — the console's stylesheet (apps/ui/src/styles/base.css) without its @font-face and token blocks:\n" +
    "   tokens.css carries those. The console reads --sans/--serif/--mono; here they point at the system's families. */\n" +
    ":root { --sans: var(--font-sans); --serif: var(--font-serif); --mono: var(--font-mono); }\n\n" + b;
}

interface ColourToken {
  name: string;
  value: { light: string; dark: string } | string;
  usage?: string;
}

/** Pure: tokens.json with its colours set to the console's; returns what changed. */
export function syncColours(
  tokens: { color: { tokens: ColourToken[] } },
  c: ReturnType<typeof consoleColours>,
): string[] {
  const changed: string[] = [];
  for (const t of tokens.color.tokens) {
    const l = c.light[t.name], d = c.dark[t.name];
    if (!l || !d || typeof t.value === "string") continue;
    if (t.value.light !== l || t.value.dark !== d) {
      changed.push(`${t.name}: ${t.value.light}/${t.value.dark} → ${l}/${d}`);
    }
    t.value = { light: l, dark: d };
  }
  return changed;
}

if (import.meta.main) {
  const dir = Deno.args[0];
  if (!dir) {
    console.error("usage: design-system.ts <dir with project/tokens.json>");
    Deno.exit(2);
  }
  const css = await Deno.readTextFile(CSS);
  const path = `${dir}/project/tokens.json`;
  const tokens = JSON.parse(await Deno.readTextFile(path));
  const changed = syncColours(tokens, consoleColours(css));
  await Deno.writeTextFile(path, JSON.stringify(tokens, null, 1) + "\n");
  await Deno.mkdir(`${dir}/project/components`, { recursive: true });
  await Deno.writeTextFile(`${dir}/project/components/bundle.css`, bundleCss(css));
  console.log(changed.length ? `colours changed:\n  ${changed.join("\n  ")}` : "colours: as they were");
  console.log("bundle.css rewritten: publish project/tokens.json and project/components/bundle.css to the artifact");
}
