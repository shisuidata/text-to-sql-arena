import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.cwd(), "..");
const dist = path.join(process.cwd(), "dist");
const baseName = (process.env.SITE_BASE ?? "/").replace(/^\/+|\/+$/g, "");
const base = baseName ? `/${baseName}` : "";
const index = JSON.parse(await readFile(path.join(root, "evidence", "index.json"), "utf8"));

async function filesUnder(directory) {
  const entries = await readdir(directory);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry);
    if ((await stat(absolute)).isDirectory()) files.push(...(await filesUnder(absolute)));
    else files.push(absolute);
  }
  return files;
}

function outputPathFor(url) {
  const pathname = decodeURIComponent(url.pathname);
  if (!pathname.startsWith(`${base}/`) && pathname !== base) return null;
  const relative = pathname.slice(base.length).replace(/^\//, "");
  if (!relative || relative.endsWith("/")) return path.join(dist, relative, "index.html");
  if (path.extname(relative)) return path.join(dist, relative);
  return path.join(dist, relative, "index.html");
}

const files = await filesUnder(dist);
const htmlFiles = files.filter((file) => file.endsWith(".html"));
const allHtml = (await Promise.all(htmlFiles.map((file) => readFile(file, "utf8")))).join("\n");
const failures = [];
let casePageCount = 0;
const expectedCasePages = [];
for (const run of index.runs) {
  const runSlug = `run-${String(run.run_id).padStart(4, "0")}`;
  const caseDirectory = path.join(root, "evidence", run.path, "cases");
  const caseFiles = (await readdir(caseDirectory)).filter((file) => /^case-run-\d{5}\.json$/.test(file));
  casePageCount += caseFiles.length;
  expectedCasePages.push(...caseFiles.map((file) =>
    path.join(dist, "runs", runSlug, "cases", file.replace(/\.json$/, ""), "index.html")
  ));
}

const expectedStaticPages = [
  "404.html",
  "index.html",
  "benchmarks/index.html",
  "runs/index.html",
  "docs/index.html",
  "docs/evidence/index.html",
  "docs/methodology/index.html",
].map((relative) => path.join(dist, relative));
const expectedPageCount = index.run_count + casePageCount + expectedStaticPages.length;
if (htmlFiles.length !== expectedPageCount) {
  failures.push(`expected ${expectedPageCount} HTML pages, found ${htmlFiles.length}`);
}
for (const page of expectedStaticPages) {
  if (!files.includes(page)) failures.push(`missing static page: ${page}`);
}

for (const run of index.runs) {
  const page = path.join(dist, "runs", `run-${String(run.run_id).padStart(4, "0")}`, "index.html");
  if (!files.includes(page)) failures.push(`missing run page: ${page}`);
  if (!allHtml.includes(run.bundle_sha256)) failures.push(`missing run digest: ${run.bundle_sha256}`);
}

for (const page of expectedCasePages) {
  if (!files.includes(page)) failures.push(`missing case evidence page: ${page}`);
}

for (const suite of index.suites) {
  if (!allHtml.includes(suite.content_hash)) failures.push(`missing suite hash: ${suite.content_hash}`);
  if (!allHtml.includes(suite.bundle_sha256)) failures.push(`missing suite digest: ${suite.bundle_sha256}`);
}

for (const file of htmlFiles) {
  const html = await readFile(file, "utf8");
  if (/file:\/\/\/(?:Users|home)\/[A-Za-z0-9._-]+\/|\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\//.test(html)) {
    failures.push(`local path leaked into ${path.relative(dist, file)}`);
  }

  const relative = path.relative(dist, file).split(path.sep).join("/");
  const route = relative.endsWith("index.html")
    ? `${base}/${relative.slice(0, -"index.html".length)}`
    : `${base}/${relative}`;
  for (const match of html.matchAll(/href=["']([^"']+)["']/g)) {
    const href = match[1];
    if (/^(?:https?:|mailto:|#)/.test(href)) continue;
    const target = outputPathFor(new URL(href, `https://example.test${route}`));
    if (target && !files.includes(target)) {
      failures.push(`broken link in ${relative}: ${href}`);
    }
  }
}

const siteUrl = new URL(process.env.SITE_URL ?? "https://arena.ss-data.cc");
const sitemapUrl = new URL(`${base}/sitemap-index.xml`, siteUrl);
const sitemapIndex = await readFile(path.join(dist, "sitemap-index.xml"), "utf8");
const sitemap = await readFile(path.join(dist, "sitemap-0.xml"), "utf8");
const robots = await readFile(path.join(dist, "robots.txt"), "utf8");
const redirects = await readFile(path.join(dist, "_redirects"), "utf8");
const expectedUrls = htmlFiles.filter((file) => path.relative(dist, file) !== "404.html")
  .map((file) => {
    const relative = path.relative(dist, file).split(path.sep).join("/");
    const route = relative.slice(0, -"index.html".length);
    return new URL(`${base}/${route}`, siteUrl).href;
  });
const listedUrls = [...sitemap.matchAll(/<url><loc>([^<]+)<\/loc><\/url>/g)].map((match) => match[1]);
if (!robots.split(/\r?\n/).includes(`Sitemap: ${sitemapUrl.href}`)) failures.push("robots.txt does not declare the public sitemap");
if (!redirects.split(/\r?\n/).includes("/sitemap.xml /sitemap-index.xml 301")) failures.push("conventional sitemap URL does not redirect to the generated sitemap index");
if (!sitemapIndex.includes(`<loc>${new URL(`${base}/sitemap-0.xml`, siteUrl).href}</loc>`)) failures.push("sitemap index does not reference the generated URL set");
if (/<lastmod>/.test(sitemap)) failures.push("sitemap uses an unverified lastmod");
if (listedUrls.length !== expectedUrls.length || new Set(listedUrls).size !== expectedUrls.length ||
    expectedUrls.some((url) => !listedUrls.includes(url))) {
  failures.push("sitemap URLs differ from the generated public HTML routes");
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Verified ${htmlFiles.length} pages, ${index.suite_count} suites, ${index.run_count} runs, and all internal links.`);
