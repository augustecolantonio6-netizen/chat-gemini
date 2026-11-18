import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import chat from "../api/chat.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8" };
const portFlag = process.argv.indexOf("--port");
const port = Number(process.env.PORT || (portFlag >= 0 && process.argv[portFlag + 1]) || 3000);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/chat") {
      const controller = new AbortController();
      res.on("close", () => { if (!res.writableEnded) controller.abort(); });
      const body = ["GET", "HEAD"].includes(req.method) ? undefined : Readable.toWeb(req);
      const request = new Request(url, { method: req.method, headers: req.headers, body, duplex: "half", signal: controller.signal });
      const response = await chat.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body), res);
      else res.end();
      return;
    }
    if (!["HEAD", "GET"].includes(req.method)) { res.writeHead(405).end(); return; }
    const path = resolve(root, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" });
    if (req.method === "HEAD") res.end();
    else await pipeline(createReadStream(path), res);
  } catch {
    if (!res.headersSent && !res.destroyed) res.writeHead(404);
    res.end();
  }
}).listen(port, "0.0.0.0", () => console.log("Chat Gemini sur http://localhost:" + port));
