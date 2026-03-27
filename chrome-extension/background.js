// background.js — MCP Google Search extension service worker

// Must match BRIDGE_TOKEN in the MCP server startup banner.
// There is intentionally no insecure default token.
const BRIDGE_TOKEN = "";
const BASE_URL = "http://127.0.0.1:3777";
const POLL_INTERVAL_MS = 2000;

let pollTimer = null;
let isProcessing = false;

// ─── REST Polling ─────────────────────────────────────────────────────────────
function startPolling() {
  if (pollTimer) return;
  schedulePoll();
}

function schedulePoll() {
  pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
}

async function poll() {
  pollTimer = null;

  if (!BRIDGE_TOKEN) {
    console.warn("[MCP] BRIDGE_TOKEN is not configured in background.js");
    schedulePoll();
    return;
  }

  // If we're still processing a previous job, skip this tick
  if (isProcessing) {
    schedulePoll();
    return;
  }

  try {
    const res = await fetch(`${BASE_URL}/pending`, {
      headers: { "Authorization": `Bearer ${BRIDGE_TOKEN}` },
    });

    if (res.status === 200) {
      const job = await res.json();
      if (job && job.id && job.query) {
        console.log(`[MCP] Search request: "${job.query}"`);
        isProcessing = true;
        let data;
        try {
          data = await doSearch(job.query);
        } catch (err) {
          data = {
            error: err.message,
            aiOverview: null, featuredSnippet: null,
            peopleAlsoAsk: [], organicResults: [], knowledgePanel: null,
          };
        } finally {
          isProcessing = false;
        }
        await sendResult(job.id, data);
      }
    }
    // 204 means no pending jobs — just continue polling
  } catch (e) {
    // MCP server not running yet — silently retry
    console.log("[MCP] Bridge not reachable, retrying...");
  }

  schedulePoll();
}

async function sendResult(id, data) {
  try {
    await fetch(`${BASE_URL}/result`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${BRIDGE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id, data }),
    });
  } catch (e) {
    console.error("[MCP] Failed to send result:", e);
  }
}

// ─── Google search using a real Chrome tab ────────────────────────────────────
async function doSearch(query) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&num=10`;

  // Open a background tab (not focused so user isn't interrupted)
  const tab = await chrome.tabs.create({ url, active: false });

  try {
    await waitForTabLoad(tab.id);
    // Wait for dynamic content (AI Overview renders after initial load)
    await sleep(3000);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractGoogleResults,
    });

    return (
      results[0]?.result ?? {
        aiOverview: null, featuredSnippet: null,
        peopleAlsoAsk: [], organicResults: [], knowledgePanel: null,
      }
    );
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Tab load timed out after 30s"));
    }, 30000);

    // May already be complete by the time we attach
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return; // tab already closed
      if (tab && tab.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── DOM extraction (injected into the Google results tab) ────────────────────
// NOTE: This function is serialised and run inside the page — no closures!
function extractGoogleResults() {
  const getText = (el) => (el ? (el.innerText || "").trim() : "");

  // AI Overview
  let aiOverview = null;
  for (const sel of [
    ".M8OgIe", ".YzVZV", "[data-md]", ".ozg4df", ".wDYxhc",
    "div[data-attrid='wa:/description']",
  ]) {
    const el = document.querySelector(sel);
    if (el && getText(el).length > 60) { aiOverview = getText(el); break; }
  }

  // Featured Snippet
  let featuredSnippet = null;
  for (const sel of [".hgKElc", ".LGOjhe", ".IZ6rdc", ".yDYNvb.lyLwlc", ".xpc"]) {
    const el = document.querySelector(sel);
    if (el && getText(el).length > 40) { featuredSnippet = getText(el); break; }
  }

  // People Also Ask
  const paaItems = [];
  document.querySelectorAll(".related-question-pair, [data-q], .dnXCYb").forEach((el) => {
    const q = getText(el);
    if (q.length > 5 && q.length < 200) paaItems.push(q);
  });

  // Knowledge Panel
  let knowledgePanel = null;
  const kpEl = document.querySelector("#rhs, .kp-wholepage, #knowledgePanel, .I6TXqe");
  if (kpEl && getText(kpEl).length > 50) knowledgePanel = getText(kpEl).slice(0, 1500);

  // Organic Results — standard containers
  const organicResults = [];
  let rank = 1;
  document.querySelectorAll("div.g, .tF2Cxc, .MjjYud .g").forEach((card) => {
    if (rank > 10) return;
    const titleEl   = card.querySelector("h3");
    const linkEl    = card.querySelector("a[href]");
    const snippetEl = card.querySelector(".VwiC3b, .IsZvec, .lEBKkf, .yDYNvb, .s3v9rd");
    if (!titleEl || !linkEl) return;
    const title   = getText(titleEl);
    const url     = linkEl.href;
    const snippet = getText(snippetEl);
    if (title && url.startsWith("http") && !url.includes("google.com/search")) {
      organicResults.push({ rank, title, url, snippet });
      rank++;
    }
  });

  // Fallback: any link with an h3
  if (organicResults.length === 0) {
    document.querySelectorAll("a[href]").forEach((a) => {
      if (rank > 10) return;
      const href = a.href;
      if (!href.startsWith("http") || href.includes("google.com")) return;
      const h3 = a.querySelector("h3") || a.closest("[data-hveid]")?.querySelector("h3");
      if (!h3) return;
      const title     = getText(h3);
      const snippetEl = a.closest("[data-hveid]")?.querySelector(".VwiC3b, .IsZvec");
      const snippet   = getText(snippetEl || null);
      if (title && !organicResults.find((r) => r.url === href)) {
        organicResults.push({ rank, title, url: href, snippet });
        rank++;
      }
    });
  }

  return { aiOverview, featuredSnippet, peopleAlsoAsk: paaItems, organicResults, knowledgePanel };
}

// ─── Keep service worker alive every 24 seconds (suspended after ~30s) ────────
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    // Ensure polling is still running
    if (!pollTimer && !isProcessing) {
      startPolling();
    }
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => startPolling());
chrome.runtime.onStartup.addListener(() => startPolling());

startPolling();
