// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";

const site = process.env.SITE_URL ?? "https://arena.ss-data.cc";
const base = process.env.SITE_BASE ?? "/";

export default defineConfig({
  site,
  base,
  trailingSlash: "always",
  integrations: [
    sitemap(),
    starlight({
      title: "SQL 模型评测台",
      description: "Text-to-SQL 评测报告、报告证据、测试用例与评测方法。",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/starlight.css"],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/shisuidata/text-to-sql-arena" }
      ],
      lastUpdated: true,
      sidebar: [
        { label: "公开边界", slug: "docs" },
        { label: "评测方法", slug: "docs/methodology" },
        { label: "证据验真", slug: "docs/evidence" }
      ]
    })
  ]
});
