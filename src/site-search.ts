// site-search.ts — Orchestrates fetch → LLM filter → follow links if needed

import { fetchAndConvert, getBlockedReason } from "./fetcher.js";
import { filterContent, NOT_FOUND_SIGNAL, isApiKeyAvailable } from "./llm.js";

const MAX_FOLLOW_LINKS = 3; // Max sub-links to follow if root page has no match

/**
 * Score a link by how many keywords from the requested information appear in its URL/text.
 */
function scoreLinkRelevance(link: { text: string; href: string }, query: string): number {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const haystack = (link.text + " " + link.href).toLowerCase();
  return words.reduce((score, w) => score + (haystack.includes(w) ? 1 : 0), 0);
}

export interface SiteSearchResult {
  answer: string;
  sourceUrl: string;
  foundContent: boolean;
}

export async function fetchFilterAndSearch(
  url: string,
  query: string,
): Promise<SiteSearchResult> {
  console.error(`[site-search] Fetching: ${url}`);

  // ── Step 1: Fetch and convert the root URL ─────────────────────────────────
  const page = await fetchAndConvert(url);

  if (page.error) {
    return {
      answer: `Failed to fetch the page: ${page.error}`,
      sourceUrl: url,
      foundContent: false,
    };
  }

  if (!page.markdown) {
    return {
      answer: "The page returned no readable content.",
      sourceUrl: url,
      foundContent: false,
    };
  }

  // ── Step 2: LLM filter on root page (skip if no API key) ────────────────
  if (!isApiKeyAvailable()) {
    console.error("[site-search] No OPENROUTER_API_KEY — returning raw markdown.");
    return { answer: page.markdown, sourceUrl: url, foundContent: true };
  }

  console.error(`[site-search] Filtering root page with LLM (${page.markdown.length} chars)...`);
  const rootResult = await filterContent(page.markdown, query, page.title, url);

  if (rootResult !== NOT_FOUND_SIGNAL) {
    return { answer: rootResult, sourceUrl: url, foundContent: true };
  }

  console.error("[site-search] Root page had no match. Scanning links...");

  // ── Step 3: Score and follow the most promising sub-links ─────────────────
  const candidates = page.links
    .filter((l) => {
      // Block internal/private URLs in followed links (SSRF protection)
      if (getBlockedReason(l.href)) return false;
      // Skip same-page anchors, images, PDFs, assets
      const ext = l.href.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
      return !["png","jpg","jpeg","gif","svg","pdf","zip","css","js","woff","woff2"].includes(ext);
    })
    .map((l) => ({ ...l, score: scoreLinkRelevance(l, query) }))
    .filter((l) => l.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FOLLOW_LINKS);

  if (candidates.length === 0) {
    return {
      answer: `The page at ${url} does not appear to contain information about: "${query}".`,
      sourceUrl: url,
      foundContent: false,
    };
  }

  // Follow each candidate and filter
  for (const candidate of candidates) {
    console.error(`[site-search] Following link: ${candidate.href} (score=${candidate.score})`);
    const subPage = await fetchAndConvert(candidate.href);
    if (subPage.error || !subPage.markdown) continue;

    console.error(`[site-search] Filtering sub-page with LLM (${subPage.markdown.length} chars)...`);
    const subResult = await filterContent(subPage.markdown, query, subPage.title, candidate.href);

    if (subResult !== NOT_FOUND_SIGNAL) {
      return { answer: subResult, sourceUrl: candidate.href, foundContent: true };
    }
  }

  // ── Step 4: Nothing found anywhere ────────────────────────────────────────
  return {
    answer:
      `Neither "${url}" nor its most relevant linked pages appear to contain information about: "${query}".\n\n` +
      `Checked sub-pages:\n` +
      candidates.map((c) => `- [${c.text}](${c.href})`).join("\n"),
    sourceUrl: url,
    foundContent: false,
  };
}
