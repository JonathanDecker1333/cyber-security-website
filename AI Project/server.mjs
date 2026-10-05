import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const defaultModel = "qwen2.5:3b";
const systemPrompt = "You are a helpful, honest assistant. Explain clearly, ask questions when context is missing, and acknowledge uncertainty. Do not assist with requests that would enable serious harm. Respect privacy and never claim to have performed actions you did not perform.";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw new HttpError(413, "Message history is too large.");
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, "Invalid JSON request.");
  }
}

export function createAppServer({ ollamaUrl = "http://127.0.0.1:11434", model = defaultModel, timeoutMs = 5 * 60 * 1000 } = {}) {
  const baseUrl = ollamaUrl.replace(/\/$/, "");
  return createHttpServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    try {
      if (request.method !== "GET" && request.headers.origin) {
        const host = request.headers.host || "";
        const localHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
        if (!localHost || request.headers.origin !== `http://${host}`) throw new HttpError(403, "Cross-origin requests are not allowed.");
      }
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = await readFile(resolve(root, "index.html"));
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return response.end(html);
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        try {
          const upstream = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3500) });
          if (!upstream.ok) throw new Error("Ollama did not respond successfully.");
          const result = await upstream.json();
          const models = Array.isArray(result.models) ? result.models.map(entry => entry.name).filter(name => typeof name === "string") : [];
          return sendJson(response, 200, { available: true, models, defaultModel: model });
        } catch {
          return sendJson(response, 200, { available: false, models: [], defaultModel: model });
        }
      }
      if (request.method === "POST" && url.pathname === "/api/chat") {
        const body = await readJson(request);
        if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 40) {
          throw new HttpError(400, "Send between 1 and 40 recent messages.");
        }
        const messages = body.messages.map(message => {
          if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || !message.content.trim() || message.content.length > 12000) {
            throw new HttpError(400, "Each message needs a supported role and text under 12,000 characters.");
          }
          return { role: message.role, content: message.content };
        });
        if (messages.at(-1).role !== "user") throw new HttpError(400, "The latest message must be from you.");
        const selectedModel = typeof body.model === "string" && body.model.length <= 120 ? body.model : model;
        const upstream = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: selectedModel, messages: [{ role: "system", content: systemPrompt }, ...messages], stream: false }),
          signal: AbortSignal.timeout(timeoutMs)
        });
        const result = await upstream.json().catch(() => ({}));
        if (!upstream.ok) throw new HttpError(upstream.status === 404 ? 503 : 502, result.error || "The local model could not complete this response.");
        const reply = result.message?.content;
        if (typeof reply !== "string" || !reply.trim()) throw new HttpError(502, "The local model returned an empty response.");
        return sendJson(response, 200, { reply, model: result.model || selectedModel });
      }
      return sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      if (response.headersSent) return response.destroy();
      if (error.name === "TimeoutError" || error.name === "AbortError") return sendJson(response, 504, { error: "The local model took too long to respond. Try a smaller model or a shorter prompt." });
      if (error.cause?.code === "ECONNREFUSED" || error.cause?.code === "ECONNRESET") return sendJson(response, 503, { error: "Ollama is not running. Start Ollama, then try again." });
      return sendJson(response, error.status || 500, { error: error.status ? error.message : "The local assistant could not complete this request." });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4174);
  const server = createAppServer({ model: process.env.OLLAMA_MODEL || defaultModel });
  server.listen(port, "127.0.0.1", () => console.log(`D chart is ready at http://127.0.0.1:${port}`));
}
