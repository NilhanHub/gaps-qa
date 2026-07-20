import { readFile } from "node:fs/promises";
import path from "node:path";

function injectConfig(html: string, publicBaseUrl: string | null) {
  const configScript = [
    "<script>",
    `window.__GAPS_QA_CONFIG__ = ${JSON.stringify({ apiBaseUrl: publicBaseUrl ?? "" })};`,
    "</script>",
  ].join("");

  if (html.includes("</head>")) {
    return html.replace("</head>", `${configScript}</head>`);
  }

  return `${configScript}${html}`;
}

async function inlineAssets(indexHtml: string, distDir: string) {
  let html = indexHtml;

  const stylesheetPattern = /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"[^>]*>/g;
  const scriptPattern = /<script[^>]+src="([^"]+)"[^>]*><\/script>/g;

  const stylesheetMatches = [...html.matchAll(stylesheetPattern)];
  for (const match of stylesheetMatches) {
    const href = match[1];
    const cssPath = path.join(distDir, href.replace(/^\//, ""));
    const css = await readFile(cssPath, "utf8");
    html = html.replace(match[0], `<style data-inline="${href}">\n${css}\n</style>`);
  }

  const scriptMatches = [...html.matchAll(scriptPattern)];
  for (const match of scriptMatches) {
    const src = match[1];
    const scriptPath = path.join(distDir, src.replace(/^\//, ""));
    const script = await readFile(scriptPath, "utf8");
    html = html.replace(match[0], `<script type="module" data-inline="${src}">\n${script}\n</script>`);
  }

  return html;
}

function fallbackHtml(publicBaseUrl: string | null) {
  return injectConfig(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GAPS QA</title>
    <style>
      body {
        margin: 0;
        padding: 24px;
        font-family: "Segoe UI", system-ui, sans-serif;
        background: #f3f0e8;
        color: #1d2a2a;
      }
      .shell {
        max-width: 720px;
        margin: 0 auto;
        background: rgba(255, 255, 255, 0.88);
        border: 1px solid rgba(29, 42, 42, 0.12);
        border-radius: 18px;
        padding: 24px;
      }
      h1 {
        margin-top: 0;
        font-size: 1.25rem;
      }
      p {
        line-height: 1.5;
      }
      code {
        background: rgba(29, 42, 42, 0.08);
        padding: 2px 6px;
        border-radius: 6px;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <h1>GAPS QA operator console</h1>
      <p>The widget bundle has not been built yet, so the server is serving a safe fallback shell.</p>
      <p>Run <code>npm run build:web</code> to publish the full operator interface.</p>
    </div>
  </body>
</html>`,
    publicBaseUrl,
  );
}

export async function loadWidgetHtml(publicBaseUrl: string | null) {
  const distDir = path.resolve(process.cwd(), "web", "dist");
  const indexPath = path.join(distDir, "index.html");

  try {
    const html = await readFile(indexPath, "utf8");
    const withAssets = await inlineAssets(html, distDir);
    return injectConfig(withAssets, publicBaseUrl);
  } catch {
    return fallbackHtml(publicBaseUrl);
  }
}
