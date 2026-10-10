// The two Node names the dev server's config (vite.config.ts) uses: the interface itself runs in a browser,
// so the Node types are not a dependency.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
declare const process: { env: Record<string, string | undefined> };
