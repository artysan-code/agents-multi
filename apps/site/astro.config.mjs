// The public site of agents-multi: the landing (src/pages, English on /, Italian on /it/) and the
// documentation (Starlight, on /docs). Static: the brain's image builds it and serves dist/ (apps/brain/public.ts).
// Its address is a placeholder the brain replaces with the real one when it serves a page: nothing of
// one instance is built in.
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://site.invalid",
  build: { inlineStylesheets: "never" },
  integrations: [
    starlight({
      title: "Agents Multi",
      description: "Every Claude you use, one setup: isolated accounts, one memory, one task list, secrets out of reach.",
      logo: { src: "./src/assets/mark.svg" },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/fonts.css", "./src/styles/docs.css"],
      sidebar: [
        { label: "Start here", items: ["docs", "docs/getting-started"] },
        { label: "Concepts", items: ["docs/profiles", "docs/configuration", "docs/console", "docs/brain", "docs/self-hosting", "docs/mcp-and-vault", "docs/updates", "docs/security"] },
        { label: "Reference", items: ["docs/commands", "docs/troubleshooting", "docs/faq", "docs/changelog"] },
      ],
      head: [
        { tag: "meta", attrs: { property: "og:image", content: "https://site.invalid/og.jpg" } },
        { tag: "meta", attrs: { name: "twitter:image", content: "https://site.invalid/og.jpg" } },
      ],
      lastUpdated: false,
      pagination: true,
    }),
  ],
});
