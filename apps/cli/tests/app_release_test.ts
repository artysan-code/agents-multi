// Tests for the desktop app's release (scripts/app-release.ts, scripts/aur.ts): placeholders stop a
// release, bundles get stable names, the manifest is Tauri's static format with one entry per package
// kind, channels only move forward (a stable one on beta too), and the AUR files agree with each other.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  assetName,
  bundleKind,
  configProblems,
  type Manifest,
  manifestFor,
  nextChannels,
  older,
} from "../../../scripts/app-release.ts";
import { DEPENDS, type Package, packageProblems, pkgbuild, srcinfo } from "../../../scripts/aur.ts";

const KEY = { plugins: { updater: { pubkey: "dW50cnVzdGVk" } } };

Deno.test("app release: a release refuses an empty site, repository or key, or two licences", () => {
  assertEquals(configProblems({ site: "https://am.example", github: "o/agents-multi" }, KEY), []);
  assertEquals(configProblems({ site: "", github: "", aur: "x" }, { plugins: { updater: { pubkey: "" } } }).length, 3);
  const tauri = { ...KEY, bundle: { license: "AGPL-3.0-only" } };
  assertEquals(configProblems({ site: "https://am.example", github: "o/a", license: "AGPL-3.0-only" }, tauri), []);
  assertEquals(configProblems({ site: "https://am.example", github: "o/a", license: "MIT" }, tauri).length, 1);
  assertEquals(configProblems({ site: "http://am.example", github: "o/r" }, KEY).length, 1);
  assertEquals(configProblems({ site: "https://am.example", github: "nope" }, {}).length, 2);
});

Deno.test("app release: bundles are found by kind and published under the same names whatever the identifier", () => {
  assertEquals(bundleKind("deb/me.artysan.agents_1.0.0_amd64.deb"), { kind: "deb", sig: false });
  assertEquals(bundleKind("rpm/x-1.0.0-1.x86_64.rpm.sig"), { kind: "rpm", sig: true });
  assertEquals(bundleKind("appimage/x_1.0.0_amd64.AppImage"), { kind: "appimage", sig: false });
  assertEquals(bundleKind("appimage/build_appimage.sh"), null);
  assertEquals(assetName("deb", "1.0.0"), "agents-multi_1.0.0_amd64.deb");
  assertEquals(assetName("rpm", "1.1.0-beta.2"), "agents-multi-1.1.0~beta.2-1.x86_64.rpm");
  assertEquals(assetName("appimage", "1.0.0"), "agents-multi_1.0.0_amd64.AppImage");
});

Deno.test("app release: the manifest has one platform per package kind, and the AppImage for the rest", () => {
  const p = (k: string) => ({ url: `https://dl.test/${k}`, signature: `sig-${k}` });
  const m = manifestFor("1.0.0", "### Added", new Date("2026-10-07T10:00:00.123Z"), {
    deb: p("deb"),
    rpm: p("rpm"),
    appimage: p("ai"),
  });
  assertEquals(m.version, "1.0.0");
  assertEquals(m.pub_date, "2026-10-07T10:00:00Z");
  assertEquals(Object.keys(m.platforms), [
    "linux-x86_64-deb",
    "linux-x86_64-rpm",
    "linux-x86_64-appimage",
    "linux-x86_64",
  ]);
  assertEquals(m.platforms["linux-x86_64"], p("ai"));
});

Deno.test("app release: versions order with a beta before its stable", () => {
  assert(older("1.0.0", "1.0.1"));
  assert(older("1.1.0-beta.1", "1.1.0-beta.2"));
  assert(older("1.1.0-beta.9", "1.1.0"));
  assert(!older("1.1.0", "1.1.0-beta.9"));
  assert(older("1.1.0-beta.9", "1.1.0-rc.1"));
  assert(older("1.1.0-rc.1", "1.1.0"));
  assert(!older("1.1.0-rc.2", "1.1.0-rc.1"));
  assert(!older("1.0.0", "1.0.0"));
});

Deno.test("app release: a stable version moves both channels, a beta only beta, and never back", () => {
  const m = (version: string): Manifest => ({ version, notes: "", pub_date: "", platforms: {} });
  const v = (c: Partial<Record<string, Manifest>>) =>
    Object.fromEntries(Object.entries(c).map(([k, x]) => [k, x!.version]));
  assertEquals(v(nextChannels({}, m("1.0.0"))), { stable: "1.0.0", beta: "1.0.0" });
  assertEquals(v(nextChannels({ stable: m("1.0.0"), beta: m("1.0.0") }, m("1.1.0-beta.1"))), { beta: "1.1.0-beta.1" });
  // the stable a beta was for reaches the beta channel too
  assertEquals(v(nextChannels({ stable: m("1.0.0"), beta: m("1.1.0-beta.3") }, m("1.1.0"))), {
    stable: "1.1.0",
    beta: "1.1.0",
  });
  // a stable fix while a newer beta runs: beta keeps its beta
  assertEquals(v(nextChannels({ stable: m("1.0.0"), beta: m("1.1.0-beta.1") }, m("1.0.1"))), { stable: "1.0.1" });
  // a release candidate goes on beta only, and after the last beta
  assertEquals(v(nextChannels({ stable: m("1.0.0"), beta: m("1.1.0-beta.3") }, m("1.1.0-rc.1"))), {
    beta: "1.1.0-rc.1",
  });
  // a workflow run again for an old tag moves nothing
  assertEquals(v(nextChannels({ stable: m("1.1.0"), beta: m("1.2.0-beta.1") }, m("1.1.0"))), {});
  assertEquals(v(nextChannels({ stable: m("1.1.0"), beta: m("1.2.0-beta.1") }, m("1.0.0-beta.4"))), {});
});

const PKG: Package = {
  name: "agents-multi-bin",
  version: "1.0.0",
  sha256: "a".repeat(64),
  github: "owner/agents-multi",
  license: "AGPL-3.0-only",
  identifier: "me.artysan.agents",
};

Deno.test("aur: only a stable version with its checksum, repository and licence makes a package", () => {
  assertEquals(packageProblems(PKG), []);
  assertEquals(packageProblems({ ...PKG, version: "1.1.0-beta.1" }), [
    "the AUR package follows the stable channel, not pre-releases",
  ]);
  assertEquals(packageProblems({ ...PKG, sha256: "SKIP", github: "", license: " " }).length, 3);
});

Deno.test("aur: the PKGBUILD repackages the release's deb with the updater off, and .SRCINFO says the same", () => {
  const b = pkgbuild(PKG), s = srcinfo(PKG);
  assertStringIncludes(b, "pkgver=1.0.0\n");
  assertStringIncludes(
    b,
    'source_x86_64=("https://github.com/owner/agents-multi/releases/download/v${pkgver}/agents-multi_${pkgver}_amd64.deb")',
  );
  assertStringIncludes(b, `sha256sums_x86_64=('${"a".repeat(64)}')`);
  assertStringIncludes(b, `> "$pkgdir/usr/lib/me.artysan.agents/package-manager"`);
  assertStringIncludes(b, "license=('AGPL-3.0-only')");
  assertStringIncludes(s, "\tlicense = AGPL-3.0-only\n");
  // the licence (with its additional terms) and the notices ship with the package, from the deb's copy
  assertStringIncludes(b, `"$pkgdir/usr/lib/me.artysan.agents/repo/$f" "$pkgdir/usr/share/licenses/$pkgname/$f"`);
  assertStringIncludes(
    s,
    "\tsource_x86_64 = https://github.com/owner/agents-multi/releases/download/v1.0.0/agents-multi_1.0.0_amd64.deb\n",
  );
  assertStringIncludes(s, `\tsha256sums_x86_64 = ${"a".repeat(64)}\n`);
  for (const d of DEPENDS) {
    assertStringIncludes(b, `'${d}'`);
    assertStringIncludes(s, `\tdepends = ${d}\n`);
  }
  assert(s.startsWith("pkgbase = agents-multi-bin\n") && s.endsWith("pkgname = agents-multi-bin\n"));
});
