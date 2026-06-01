// Minimalny Node HTTP listener dla TanStack Start (self-hosted).
// `dist/server/server.js` eksportuje obiekt z `.fetch(request)` (Web Fetch API).
// Tutaj owijamy go w klasyczny `http.createServer` i serwujemy statyki z dist/client.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import handler from "./dist/server/server.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLIENT_DIR = join(__dirname, "dist", "client");
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";

const MIME = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".html": "text/html; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".map": "application/json", ".txt": "text/plain",
};

async function tryServeStatic(urlPath) {
  // bezpieczne normalizowanie ścieżki (ucinamy ../)
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(CLIENT_DIR, rel);
  if (!filePath.startsWith(CLIENT_DIR)) return null;
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return null;
    const data = await readFile(filePath);
    const ct = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
    return { data, ct };
  } catch {
    return null;
  }
}

function nodeReqToFetch(req) {
  const url = `http://${req.headers.host || "localhost"}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
    else if (v != null) headers.set(k, String(v));
  }
  const init = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = new ReadableStream({
      start(controller) {
        req.on("data", (c) => controller.enqueue(c));
        req.on("end", () => controller.close());
        req.on("error", (e) => controller.error(e));
      },
    });
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function writeFetchResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  if (!response.body) return res.end();
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

const server = createServer(async (req, res) => {
  try {
    // 1) statyki z dist/client (assets, favicon, itp.)
    if (req.method === "GET" || req.method === "HEAD") {
      const hit = await tryServeStatic(req.url.split("?")[0]);
      if (hit) {
        res.statusCode = 200;
        res.setHeader("content-type", hit.ct);
        res.setHeader("cache-control", "public, max-age=3600");
        return res.end(hit.data);
      }
    }
    // 2) SSR handler
    const fetchReq = nodeReqToFetch(req);
    const response = await handler.fetch(fetchReq);
    await writeFetchResponse(res, response);
  } catch (e) {
    console.error("[server] error:", e);
    if (!res.headersSent) res.statusCode = 500;
    res.end("Internal Server Error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[ask-sylabus] listening on http://${HOST}:${PORT}`);
});
