import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const client = await readFile(new URL("./client.mjs", import.meta.url));
const topics = new Set(["delivery", "pricing", "other"]);
const manualReview = () => ({ status: "manual_review", topic: null, draft: null });

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

// Validate provider output here; never spread untrusted fields.
export async function triage(text, provider = classify) {
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("AI deadline exceeded"));
        controller.abort();
      }, 300);
    });
    // Also bounds asynchronous providers that ignore AbortSignal.
    const raw = await Promise.race([
      Promise.resolve().then(() => provider(text, { signal: controller.signal })),
      deadline,
    ]);
    const value = JSON.parse(raw);
    if (!value || !topics.has(value.topic) ||
        typeof value.draft !== "string" || !value.draft.trim()) return manualReview();
    return { status: "ready", topic: value.topic, draft: value.draft.trim() };
  } catch {
    return manualReview();
  } finally {
    clearTimeout(timer);
  }
}

export function createApp({ provider = classify } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && ["/", "/client.mjs"].includes(request.url)) {
      response.writeHead(200, { "Content-Type": request.url === "/"
        ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8" });
      response.end(request.url === "/" ? html : client);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    let text;
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body.text !== "string" || !body.text.trim()) {
        return json(response, 400, { status: "invalid_input" });
      }
      text = body.text.trim();
    } catch {
      return json(response, 400, { status: "invalid_input" });
    }
    json(response, 200, await triage(text, provider));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
