import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");
const [html, app, workflow] = await Promise.all([
  read("index.html"),
  read("app.js"),
  read(".github/workflows/deploy-pages.yml"),
]);

const failures = [];
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicateIds.length) failures.push(`duplicate HTML ids: ${[...new Set(duplicateIds)].join(", ")}`);

const localAssets = [...html.matchAll(/(?:src|href)="([^"?#]+)(?:[?#][^"]*)?"/g)]
  .map((match) => match[1])
  .filter((asset) => !/^(?:https?:|data:|#)/.test(asset));
for (const asset of localAssets) {
  try {
    await access(path.join(root, asset));
  } catch {
    failures.push(`missing local asset: ${asset}`);
  }
}

const externalAssetTags = html.match(/<(?:script|link)\b[^>]+(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)[^>]*>/g) || [];
for (const tag of externalAssetTags) {
  if (!/\bintegrity="sha384-[^"]+"/.test(tag)) failures.push(`missing SRI: ${tag}`);
  if (!/\bcrossorigin="anonymous"/.test(tag)) failures.push(`missing crossorigin: ${tag}`);
}

if (!html.includes("Content-Security-Policy")) failures.push("index.html is missing a Content Security Policy");
if (!app.includes("DOMPurify.sanitize")) failures.push("Markdown output is not sanitized with DOMPurify");
if (/securityLevel:\s*["']loose["']/.test(app)) failures.push("Mermaid securityLevel must not be loose");
if (!workflow.includes("npm test")) failures.push("deployment workflow does not run npm test");

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${ids.length} unique ids, ${localAssets.length} local assets, and ${externalAssetTags.length} SRI-protected CDN assets.`);
}
