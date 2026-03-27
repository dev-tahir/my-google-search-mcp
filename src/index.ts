import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatMarkdown } from "./formatter.js";
import { startBridge, isExtensionConnected, searchViaExtension } from "./bridge.js";
import { fetchFilterAndSearch } from "./site-search.js";

const server = new McpServer({
  name: "google-search",
  version: "1.0.0",
});

// ─── Shared schemas (declared as vars to avoid TS "type instantiation" errors) ─
const googleSearchSchema = { query: z.string().min(1).describe("The search query to look up on Google") };
const fetchFilterSchema  = {
  link:  z.string().url().describe("The URL to fetch and extract data from"),
  query: z.string().min(1).describe("The exact data you want extracted from this page. Be specific about the data points you need — e.g. 'the npm install command', 'all pricing tiers and their monthly cost', 'the API endpoint for creating a user and its required parameters'. Do NOT describe the page; state the precise information you want returned."),
};

//  Tool 1: Google Search
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — zod ↔ TS 5.9 type depth false positive
server.tool(
  "google_search",
  "Search Google and return results as Markdown. Includes AI Overview, Featured Snippet, Knowledge Panel, top organic results, and People Also Ask questions. Requires the MCP Google Search Chrome extension to be installed and Chrome to be open.",
  googleSearchSchema,
  async ({ query }) => {
    try {
      if (!(await isExtensionConnected())) {
        return {
          content: [{ type: "text", text: "## Extension Not Connected\n\nThe MCP Google Search Chrome extension is not connected.\n\nMake sure:\n1. Chrome is open\n2. The extension is installed and enabled (`chrome://extensions`)\n3. This MCP server is running" }],
          isError: true,
        };
      }
      console.error(`[google-search] Searching via Chrome extension: "${query}"`);
      const data = await searchViaExtension(query);
      return { content: [{ type: "text", text: formatMarkdown(data) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : "An unexpected error occurred";
      // Strip any file paths or stack-trace fragments before returning to client
      const safeMessage = message.replace(/\bat\s+\S+:\d+:\d+\b/g, "").trim();
      return { content: [{ type: "text", text: `## Error\n\n${safeMessage}` }], isError: true };
    }
  }
);

//  Tool 2: Fetch & Filter 
server.tool(
  "fetch_and_filter",
  "Fetch any URL and return only the specific information requested. Uses an LLM to extract the exact data the agent asks for, and if the main page has no match it follows the most relevant links automatically.",
  fetchFilterSchema,
  async ({ link, query }) => {
    try {
      const result = await fetchFilterAndSearch(link, query);
      const header = result.foundContent
        ? `**Source:** ${result.sourceUrl}\n\n---\n\n`
        : `**Source:** ${result.sourceUrl}\n\n> No matching content found.\n\n---\n\n`;
      return { content: [{ type: "text", text: header + result.answer }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : "An unexpected error occurred";
      const safeMessage = message.replace(/\bat\s+\S+:\d+:\d+\b/g, "").trim();
      return { content: [{ type: "text", text: `## Error\n\n${safeMessage}` }], isError: true };
    }
  }
);

//  Startup 
async function main() {
  await startBridge(3777);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] Server running. Tools: google_search, fetch_and_filter");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
