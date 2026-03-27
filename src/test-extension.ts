// test-extension.ts — Tests the Chrome extension path (no Puppeteer)
import { startBridge, isExtensionConnected, searchViaExtension } from "./bridge.js";
import { formatMarkdown } from "./formatter.js";

const QUERY = "vscode mobile";
const WAIT_TIMEOUT_MS = 30_000;

async function waitForExtension(): Promise<void> {
  const start = Date.now();
  process.stderr.write("[test] Waiting for Chrome extension to connect");
  while (!isExtensionConnected()) {
    if (Date.now() - start > WAIT_TIMEOUT_MS) {
      throw new Error(
        "\n\n[test] Extension did not connect within 30 seconds.\n" +
        "Make sure:\n" +
        "  1. Chrome is open\n" +
        "  2. The extension is installed (chrome://extensions)\n" +
        "  3. The extension is enabled (toggle is ON)\n"
      );
    }
    process.stderr.write(".");
    await new Promise((r) => setTimeout(r, 500));
  }
  process.stderr.write(" connected!\n");
}

async function main() {
  console.error("[test] Starting WebSocket bridge on port 3777...");
  startBridge(3777);

  await waitForExtension();

  console.error(`[test] Searching for: "${QUERY}"`);
  const data = await searchViaExtension(QUERY);

  console.error("\n--- Results Summary ---");
  console.error(`AI Overview    : ${data.aiOverview    ? data.aiOverview.slice(0, 80) + "..." : "not found"}`);
  console.error(`Featured Snippet: ${data.featuredSnippet ? data.featuredSnippet.slice(0, 80) + "..." : "not found"}`);
  console.error(`People Also Ask : ${data.peopleAlsoAsk.length} questions`);
  console.error(`Organic Results : ${data.organicResults.length} results`);
  console.error(`Knowledge Panel : ${data.knowledgePanel ? "found" : "not found"}`);

  console.log("\n--- Markdown Output ---\n");
  console.log(formatMarkdown(data));

  process.exit(0);
}

main().catch((err) => {
  console.error("\n[test] Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
