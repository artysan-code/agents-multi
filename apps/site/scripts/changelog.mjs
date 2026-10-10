// changelog.mjs — the docs' Changelog page, written from the repository's CHANGELOG.md before every
// build, so the release notes are written once (by `deno task release`). The page is generated, and
// git ignores it. In the brain's image the site is built in /site with CHANGELOG.md copied to /, which
// is the same ../../CHANGELOG.md as in a checkout.
import { readFileSync, writeFileSync } from "node:fs";

const source = new URL("../../../CHANGELOG.md", import.meta.url);
const target = new URL("../src/content/docs/docs/changelog.md", import.meta.url);

const text = readFileSync(source, "utf8");
const start = text.search(/^## \[/m);
const body = (start < 0 ? "" : text.slice(start))
  // "## [0.7.0] - 2026-10-07" → "## 0.7.0 · 2026-10-07"
  .replace(/^## \[([^\]]+)\](?: - (\S+))?/gm, (_, v, d) => `## ${v}${d ? ` · ${d}` : ""}`)
  // the short commit hash at the end of a line, set as code
  .replace(/ \(([0-9a-f]{7,40})\)$/gm, " (`$1`)");

writeFileSync(
  target,
  `---
title: Changelog
description: Every version of agents-multi and what changed in it, newest first.
---

<!-- Generated from CHANGELOG.md by apps/site/scripts/changelog.mjs: change that file, not this one. -->

Versions follow [Semantic Versioning](https://semver.org); stable versions, betas (\`X.Y.Z-beta.N\`) and release candidates (\`X.Y.Z-rc.N\`)
are listed together. The console shows the same notes after an update, under **What's new**.

${body.trim()}
`,
);
