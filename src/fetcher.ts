import { lookup } from "dns/promises";
import { isIP } from "net";
import { parse } from "node-html-parser";
import TurndownService from "turndown";

// ─── SSRF protection ─────────────────────────────────────────────────────────
// Returns a reason string if the URL should be blocked, null if it is safe.
function isBlockedIpLiteral(host: string): boolean {
  const normalized = host.toLowerCase();

  if (normalized === "::1") return true;
  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true;
  if (normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;

  const privatePatterns = [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
    /^0\./,
  ];

  return privatePatterns.some((re) => re.test(normalized));
}

export function getBlockedReason(urlStr: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return "Invalid URL";
  }

  // Only allow HTTP/HTTPS
  if (![ "http:", "https:" ].includes(parsed.protocol)) {
    return `Blocked protocol: ${parsed.protocol}`;
  }

  const host = parsed.hostname.toLowerCase();

  // Localhost variants
  if (host === "localhost" || host === "0.0.0.0" || host === "::1") {
    return "Blocked: localhost";
  }

  if (isIP(host) && isBlockedIpLiteral(host)) {
    return "Blocked: private/internal IP range";
  }

  // Named cloud metadata endpoints
  const blockedHosts = [
    "metadata.google.internal",
    "metadata.internal",
    "instance-data",
    "computemetadata.v1",
  ];
  if (blockedHosts.includes(host)) {
    return "Blocked: cloud metadata endpoint";
  }

  return null; // safe
}

async function ensureHostnameResolvesPublic(parsedUrl: URL): Promise<string | null> {
  const host = parsedUrl.hostname;

  if (isIP(host)) {
    return isBlockedIpLiteral(host) ? "Blocked: private/internal IP range" : null;
  }

  try {
    const results = await lookup(host, { all: true, verbatim: true });
    if (results.length === 0) {
      return "Blocked: hostname did not resolve";
    }
    if (results.some((entry) => isBlockedIpLiteral(entry.address))) {
      return "Blocked: hostname resolves to a private/internal IP";
    }
  } catch {
    return "Blocked: hostname resolution failed";
  }

  return null;
}

async function validateFetchTarget(urlStr: string): Promise<{ parsedUrl?: URL; error?: string }> {
  const blocked = getBlockedReason(urlStr);
  if (blocked) {
    return { error: `Request blocked: ${blocked}` };
  }

  const parsedUrl = new URL(urlStr);
  const resolutionBlock = await ensureHostnameResolvesPublic(parsedUrl);
  if (resolutionBlock) {
    return { error: `Request blocked: ${resolutionBlock}` };
  }

  return { parsedUrl };
}

async function fetchWithValidatedRedirects(
  startUrl: string,
): Promise<{ response?: Response; finalUrl?: string; error?: string }> {
  let currentUrl = startUrl;

  for (let redirectCount = 0; redirectCount < 5; redirectCount++) {
    const target = await validateFetchTarget(currentUrl);
    if (target.error || !target.parsedUrl) {
      return { error: target.error ?? "Fetch blocked" };
    }

    try {
      const response = await fetch(target.parsedUrl.toString(), {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(20_000),
        redirect: "manual",
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          return { error: `Redirect ${response.status} missing Location header` };
        }

        currentUrl = new URL(location, target.parsedUrl).toString();
        continue;
      }

      return { response, finalUrl: target.parsedUrl.toString() };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { error: "Too many redirects" };
}

const td = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});

// Remove clutter before converting
td.remove(["script", "style", "noscript", "img", "head", "nav", "footer", "header", "aside", "form", "button", "iframe"]);
// svg is not in HTMLElementTagNameMap so use a custom rule
td.addRule("remove-svg", {
  filter: (node) => node.nodeName.toLowerCase() === "svg",
  replacement: () => "",
});

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface FetchResult {
  markdown: string;
  links: { text: string; href: string }[];
  title: string;
  error?: string;
}

export async function fetchAndConvert(url: string, maxChars = 20000): Promise<FetchResult> {
  let html: string;
  let finalUrl = url;
  try {
    const result = await fetchWithValidatedRedirects(url);
    if (result.error || !result.response) {
      return { markdown: "", links: [], title: "", error: result.error ?? "Fetch failed" };
    }

    const res = result.response;
    finalUrl = result.finalUrl ?? url;
    if (!res.ok) {
      return { markdown: "", links: [], title: "", error: `HTTP ${res.status} ${res.statusText}` };
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("html") && !contentType.includes("text")) {
      return { markdown: "", links: [], title: "", error: `Non-HTML content type: ${contentType}` };
    }
    html = await res.text();
  } catch (err) {
    return {
      markdown: "",
      links: [],
      title: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const root = parse(html);

  // Page title
  const title = root.querySelector("title")?.text.trim() ?? "";

  // Extract all internal/external links
  const links: { text: string; href: string }[] = [];
  const base = new URL(finalUrl);
  root.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    const text = a.text.trim().replace(/\s+/g, " ").slice(0, 120);
    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) return;
    try {
      const resolved = new URL(href, base).toString();
      if (text && resolved.startsWith("http")) links.push({ text, href: resolved });
    } catch { /* ignore invalid URLs */ }
  });

  // Remove noisy elements before markdown conversion
  ["nav", "footer", "header", "aside", ".sidebar", ".navbar", ".menu",
    "#nav", "#footer", "#header", "#sidebar", ".cookie-banner", ".advertisement",
  ].forEach((sel) => {
    root.querySelectorAll(sel).forEach((el) => el.remove());
  });

  // Prefer <main> or <article> if available for cleaner content
  const contentEl =
    root.querySelector("main") ??
    root.querySelector("article") ??
    root.querySelector(".content") ??
    root.querySelector("#content") ??
    root.querySelector("body") ??
    root;

  // Convert to markdown and trim to maxChars
  let markdown = td.turndown(contentEl.toString());
  // Collapse excessive blank lines
  markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();
  if (markdown.length > maxChars) {
    markdown = markdown.slice(0, maxChars) + "\n\n… (content truncated)";
  }

  return { markdown, links, title };
}
