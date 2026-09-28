import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(scriptDir, "..");
const repoRoot = resolve(siteRoot, "..");
const docsTarget = resolve(siteRoot, "src/content/docs/docs");

const docs = [
  ["methodology.md", "评测方法", "固定题库、确定性执行、评分公式与结果解释边界。", 1],
  ["evidence.md", "报告证据与验真", "报告证据目录、脱敏规则、摘要算法和离线复核步骤。", 2]
];

await rm(resolve(siteRoot, "src/content/docs"), { recursive: true, force: true });
await mkdir(docsTarget, { recursive: true });

const overview = `---
title: 公开边界
description: 对外只提供评测报告、报告证据、测试用例和评测方法。
sidebar:
  order: 0
---

公开站点是独立的证据发布产品，不是本地评测工作台，也不公开工作台的操作、配置或内部实现文档。

对外内容严格限定为四类：

- **评测报告**：经明确选择并发布的运行结论；
- **报告证据**：支持报告结论的 Prompt、模型输出、SQL、执行结果、评分明细、事件记录与校验摘要；
- **测试用例**：报告实际使用的题目、Schema、Seed、语义定义、金标与版本哈希；
- **评测方法**：评分公式、控制变量、执行边界和结果解释限制。

报告不会因本地新增运行自动同步。只有明确指定发布某次运行时，才更新公开证据和站点内容。
`;
await writeFile(resolve(docsTarget, "index.md"), overview);

for (const [file, title, description, order] of docs) {
  const source = await readFile(resolve(repoRoot, "docs", file), "utf8");
  let body = source.replace(/^# .+?\n+/, "");
  body = body.replace(/\]\(\.\.\/evidence\/([^)]+)\)/g, (_, target) => {
    const view = target.endsWith("/") ? "tree" : "blob";
    return `](https://github.com/shisuidata/text-to-sql-arena/${view}/main/evidence/${target})`;
  });
  body = body.replace(/\]\((?:\.\/)?([a-z0-9-]+)\.md(#[^)]*)?\)/gi, (_, slug, anchor = "") => `](../${slug}/${anchor})`);
  const frontmatter = `---\ntitle: ${title}\ndescription: ${description}\nsidebar:\n  order: ${order}\n---\n\n`;
  await writeFile(resolve(docsTarget, file), frontmatter + body);
}
