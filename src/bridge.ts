import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomUUID, timingSafeEqual } from "crypto";
import type { GoogleSearchData } from "./formatter.js";

// ─── Types ────────────────────────────────────────────────────────────────────
interface SearchResultFromExtension {
  aiOverview:      string | null;
  featuredSnippet: string | null;
  peopleAlsoAsk:   string[];
  organicResults:  { rank: number; title: string; url: string; snippet: string }[];
  knowledgePanel:  string | null;
  error?:          string;
}

interface PendingRequest {
  resolve: (data: SearchResultFromExtension) => void;
  reject:  (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface Job {
  id:    string;
  query: string;
}

// ─── State ────────────────────────────────────────────────────────────────────
const jobQueue: Job[] = [];
const pending = new Map<string, PendingRequest>();
let extensionLastSeen = 0;
let bridgeStarted = false;
let isBridgeOwner = false;  // true only if this process successfully bound the port
let bridgePort = 3777;

// ─── Auth token ───────────────────────────────────────────────────────────────
const MAX_BODY_BYTES = 64 * 1024;

// Read lazily so bin.ts can set process.env.BRIDGE_TOKEN before the first
// request arrives.
function getBridgeToken(): string {
  const token = process.env.BRIDGE_TOKEN?.trim();
  if (!token) {
    throw new Error("BRIDGE_TOKEN is not configured. Start the server via bin.ts or set BRIDGE_TOKEN explicitly.");
  }
  return token;
}

// ─── Rate limiting (max 20 searches per 60-second window) ────────────────────
const MAX_REQUESTS_PER_MINUTE = 20;
let requestCount = 0;
let windowStart = Date.now();

function checkRateLimit(): boolean {
  const now = Date.now();
  if (now - windowStart >= 60_000) {
    windowStart = now;
    requestCount = 0;
  }
  return ++requestCount <= MAX_REQUESTS_PER_MINUTE;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBuf = Buffer.from(actual, "utf-8");
  const expectedBuf = Buffer.from(expected, "utf-8");
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}

function isAuthorized(req: IncomingMessage, parsedUrl: URL): boolean {
  const headerToken = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/, "");
  const queryToken  = parsedUrl.searchParams.get("token") ?? "";
  const expected    = getBridgeToken();
  return tokensEqual(headerToken, expected) || tokensEqual(queryToken, expected);
}

// CORS headers kept for safety (covers any future browser environments)
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "chrome-extension://lllmfbkkkhpmkcpklhdhkbninfogigpa",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

function send(res: ServerResponse, status: number, body?: object): void {
  const json = body ? JSON.stringify(body) : "";
  res.writeHead(status, {
    ...CORS_HEADERS,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

// ─── Bridge server ────────────────────────────────────────────────────────────
export function startBridge(port = 3777): Promise<void> {
  bridgePort = port;
  if (bridgeStarted) return Promise.resolve();
  bridgeStarted = true;

  return new Promise<void>((resolve) => {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Only accept loopback connections
    const host = req.headers["host"] ?? "";
    if (!host.startsWith("127.0.0.1") && !host.startsWith("localhost")) {
      send(res, 403, { error: "Forbidden" });
      return;
    }

    // Handle CORS preflight (OPTIONS never carries credentials — respond unconditionally)
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    // Parse URL once so we can read query params for token auth
    const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname  = parsedUrl.pathname;

    if (!isAuthorized(req, parsedUrl)) {
      send(res, 401, { error: "Unauthorized" });
      return;
    }

    // GET /status — reports whether the extension has polled recently
    if (req.method === "GET" && pathname === "/status") {
      send(res, 200, { connected: Date.now() - extensionLastSeen < 15_000 });
      return;
    }

    // POST /search — used by non-owner MCP processes to dispatch a search job
    if (req.method === "POST" && pathname === "/search") {
      let body: { query?: string };
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid request body";
        const status = message === "Request body too large" ? 413 : 400;
        send(res, status, { error: message });
        return;
      }

      const { query } = body;
      if (!query) {
        send(res, 400, { error: "Missing query" });
        return;
      }

      if (Date.now() - extensionLastSeen >= 15_000) {
        send(res, 503, { error: "Extension not connected" });
        return;
      }

      if (!checkRateLimit()) {
        send(res, 429, { error: "Rate limit exceeded: max 20 searches per minute." });
        return;
      }

      const id = randomUUID();
      // Stream the result back once the extension responds
      const result = await new Promise<SearchResultFromExtension>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          const qi = jobQueue.findIndex((j) => j.id === id);
          if (qi !== -1) jobQueue.splice(qi, 1);
          reject(new Error("Extension search timed out after 45 seconds."));
        }, 45_000);
        pending.set(id, { resolve, reject, timeout });
        jobQueue.push({ id, query });
      }).catch((err: Error) => ({ error: err.message } as SearchResultFromExtension));

      send(res, 200, result);
      return;
    }

    // GET /pending — extension polls for next job
    if (req.method === "GET" && pathname === "/pending") {
      extensionLastSeen = Date.now();
      const job = jobQueue.shift();
      if (!job) {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }
      send(res, 200, { id: job.id, query: job.query });
      return;
    }

    // POST /result — extension submits result for a completed job
    if (req.method === "POST" && pathname === "/result") {
      let body: { id?: string; data?: SearchResultFromExtension };
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid request body";
        const status = message === "Request body too large" ? 413 : 400;
        send(res, status, { error: message });
        return;
      }

      const { id, data } = body;
      if (!id || !data || !pending.has(id)) {
        send(res, 404, { error: "Unknown request ID" });
        return;
      }

      const pendingReq = pending.get(id)!;
      clearTimeout(pendingReq.timeout);
      pending.delete(id);

      if (data.error) {
        pendingReq.reject(new Error(data.error));
      } else {
        pendingReq.resolve(data);
      }
      send(res, 200, { ok: true });
      return;
    }

    send(res, 404, { error: "Not found" });
  });

  server.listen(port, "127.0.0.1", () => {
    isBridgeOwner = true;
    console.error(`[bridge] Listening on http://127.0.0.1:${port} — waiting for Chrome extension`);
    resolve();
  });

  server.on("error", (err: Error) => {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      // Another process already owns the bridge — delegate to it
      console.error(`[bridge] Port ${port} already in use — delegating to existing bridge process`);
    } else {
      console.error(`[bridge] Server error: ${err.message}`);
    }
    resolve(); // either way, we know our ownership status now
  });
  }); // end new Promise
}

// ─── Helpers for non-owner processes to delegate to the bridge ───────────────
function bridgeUrl(path: string): string {
  return `http://127.0.0.1:${bridgePort}${path}`;
}

function authHeader(): { Authorization: string } {
  return { Authorization: `Bearer ${getBridgeToken()}` };
}

async function delegateSearch(query: string): Promise<GoogleSearchData> {
  const res = await fetch(bridgeUrl("/search"), {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (res.status === 503) {
    throw new Error(
      "Chrome extension is not connected.\n" +
      "Make sure:\n" +
      "  1. Chrome is open\n" +
      "  2. The MCP Google Search extension is installed and enabled\n" +
      "  3. The MCP server is running (it starts the bridge on port 3777)\n"
    );
  }
  if (res.status === 429) throw new Error("Rate limit exceeded: max 20 searches per minute. Please wait before searching again.");
  if (!res.ok) throw new Error(`Bridge error: ${res.status}`);

  const data = await res.json() as SearchResultFromExtension;
  if (data.error) throw new Error(data.error);
  return { query, ...data };
}

// ─── Public API ───────────────────────────────────────────────────────────────
export async function isExtensionConnected(): Promise<boolean> {
  if (isBridgeOwner) {
    return Date.now() - extensionLastSeen < 15_000;
  }
  // This process doesn't own the bridge — ask the running one
  try {
    const res = await fetch(bridgeUrl("/status"), { headers: authHeader() });
    if (!res.ok) return false;
    const body = await res.json() as { connected: boolean };
    return body.connected === true;
  } catch {
    return false;
  }
}

export async function searchViaExtension(query: string): Promise<GoogleSearchData> {
  if (!isBridgeOwner) {
    // Delegate entirely to the bridge process that owns the in-memory queues
    return delegateSearch(query);
  }

  return new Promise((resolve, reject) => {
    if (!checkRateLimit()) {
      return reject(new Error("Rate limit exceeded: max 20 searches per minute. Please wait before searching again."));
    }

    // Cryptographically secure request ID (prevents ID-guessing attacks)
    const id = randomUUID();

    const timeout = setTimeout(() => {
      pending.delete(id);
      // Also remove from queue if the extension never picked it up
      const qi = jobQueue.findIndex((j) => j.id === id);
      if (qi !== -1) jobQueue.splice(qi, 1);
      reject(new Error("Extension search timed out after 45 seconds. The Google tab may have been blocked or took too long."));
    }, 45_000);

    pending.set(id, {
      resolve: (data) => resolve({ query, ...data }),
      reject,
      timeout,
    });

    jobQueue.push({ id, query });
  });
}
