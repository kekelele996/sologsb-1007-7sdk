import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outDir = join(process.cwd(), "dist", "client");
const manifest = JSON.parse(await readFile(join(outDir, ".vite", "manifest.json"), "utf8"));
const entry = manifest["src/entry-client.tsx"];
if (!entry?.file) throw new Error("SolidStart client entry is missing from the Vite manifest.");

const assets = Object.values(manifest)
  .flatMap((item) => item.css ?? [])
  .map((file) => `<link rel="stylesheet" href="/${file}" />`)
  .join("");
const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#17212b" />
  <meta name="description" content="口述历史转写与标注编辑器" />
  <link rel="icon" href="data:," />
  <title>口述历史转写与标注编辑器</title>
  ${assets}
  <link rel="modulepreload" href="/${entry.file}" />
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/${entry.file}"></script>
</body>
</html>`;
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "index.html"), html);
console.log(`[solid-start] generated ${join(outDir, "index.html")}`);
