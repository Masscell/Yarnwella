import { extname, join, normalize, resolve } from "node:path";
import { readFile } from "node:fs/promises";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

export default async function handler(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  const requested = pathname === "/" ? "/index.html" : pathname;
  
  // Build the file path, defaulting to index.html for SPA routing
  let filePath = join(process.cwd(), requested);
  
  try {
    const body = await readFile(filePath);
    res.setHeader("Content-Type", mimeTypes[extname(filePath)] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.status(200).send(body);
  } catch {
    // Fall back to index.html for SPA routing
    try {
      const body = await readFile(join(process.cwd(), "index.html"));
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.status(200).send(body);
    } catch {
      res.status(404).send("Not found");
    }
  }
}
