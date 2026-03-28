# My Google Search MCP

<div align="center">

**Real Google search for AI agents, powered by your own Chrome session**

[![npm version](https://img.shields.io/npm/v/my-google-search-mcp?color=0f766e)](https://www.npmjs.com/package/my-google-search-mcp)
[![license](https://img.shields.io/badge/license-MIT-1f2937)](LICENSE)
[![mcp](https://img.shields.io/badge/MCP-compatible-2563eb)](https://modelcontextprotocol.io)
[![github](https://img.shields.io/badge/GitHub-dev--tahir%2Fmy--google--search--mcp-111827?logo=github)](https://github.com/dev-tahir/my-google-search-mcp)

</div>

---

## What this is

`my-google-search-mcp` is a Model Context Protocol server that gives AI clients two useful tools:

- `google_search` for real Google results through your actual Chrome browser
- `fetch_and_filter` for pulling only the useful parts of a web page

Instead of fighting bot detection with scraping tricks, this project uses your real Chrome session through a lightweight extension.

## Why it is useful

| Feature | Benefit |
|---|---|
| Real browser search | Results come from your own Chrome session |
| Better agent output | Search results are returned as clean Markdown |
| Focused page extraction | Optional LLM filtering removes page bloat |
| Easy MCP setup | Works with Claude Desktop, Cursor, VS Code, Copilot, and other MCP clients |
| Local bridge | The extension talks to a loopback server on `127.0.0.1` |

## Quick Start

> To use `google_search`, you need both the Chrome extension and the MCP server config.

### Requirements

- Node.js and npm
- Google Chrome
- An MCP-compatible client
- The bundled Chrome extension from `chrome-extension/`

Optional:

- `OPENROUTER_API_KEY` if you want tighter filtering from `fetch_and_filter`

### 1. Install the Chrome extension

1. Download the project from the [GitHub release](https://github.com/dev-tahir/my-google-search-mcp/releases/tag/v1.0.2) or clone this repo
2. Open `chrome://extensions`
3. Turn on **Developer mode**
4. Click **Load unpacked**
5. Select the `chrome-extension/` folder

### 2. Add the MCP server to your client

```json
{
  "mcpServers": {
    "my-google-search-mcp": {
      "command": "npx",
      "args": ["-y", "my-google-search-mcp"]
    }
  }
}
```

You do not need to install the npm package first. `npx` will download and run it automatically.

### 3. Start the server once

Run:

```bash
npx my-google-search-mcp
```

On first run, the CLI will:

- start the local MCP server
- start the local bridge on `127.0.0.1:3777`
- generate a bridge token
- save that token to `~/.mcp-google-search.json`
- print the token for you

### 4. Put the token in the extension

Open `chrome-extension/background.js` and update:

```js
const BRIDGE_TOKEN = "your-token-here";
```

Then reload the extension in `chrome://extensions`.

### 5. Use it

After setup:

- restart your MCP client if needed
- keep Chrome open
- use `google_search` from your AI client

That is the full setup.

## How it works

### Search flow

```text
+-----------+
| AI Client |
+-----------+
      |
      v
+----------------------+
| my-google-search-mcp |
+----------------------+
      |
      v
+--------------+
| Local Bridge |
+--------------+
      |
      v
+------------------+
| Chrome Extension |
+------------------+
      |
      v
+---------------+
| Google Search |
+---------------+
```

### Page extraction flow

```text
URL
  |
  v
Fetch page
  |
  v
Clean HTML -> Markdown
  |
  v
Optional LLM filtering
```

## Tools

### `google_search`

Searches Google and returns structured Markdown that may include:

- AI Overview
- Featured Snippet
- Knowledge Panel
- Top organic results
- People Also Ask

Requirement:

- Chrome must be open
- the extension must be installed
- the extension token and server token must match

### `fetch_and_filter`

Fetches a URL and returns only the relevant content.

Without `OPENROUTER_API_KEY`:

- returns cleaned Markdown from the page

With `OPENROUTER_API_KEY`:

- uses an LLM to extract only the parts that match the query
- can follow relevant sub-links if the root page does not contain the answer

## Client Examples

### Claude Desktop

```json
{
  "mcpServers": {
    "my-google-search-mcp": {
      "command": "npx",
      "args": ["-y", "my-google-search-mcp"]
    }
  }
}
```

### VS Code / Copilot / Cursor

```json
{
  "mcpServers": {
    "my-google-search-mcp": {
      "command": "npx",
      "args": ["-y", "my-google-search-mcp"]
    }
  }
}
```

### With environment variables

```json
{
  "mcpServers": {
    "my-google-search-mcp": {
      "command": "npx",
      "args": ["-y", "my-google-search-mcp"],
      "env": {
        "BRIDGE_TOKEN": "your-secret-token",
        "OPENROUTER_API_KEY": "sk-or-v1-..."
      }
    }
  }
}
```

## Environment Variables

You can use `.env.example` or provide env vars through your MCP client:

```env
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=google/gemini-2.0-flash-001
BRIDGE_TOKEN=your-secret-token
```

## Troubleshooting

### Extension not connected

- Make sure Chrome is open
- Make sure the extension is loaded
- Make sure the token in `background.js` matches the server token

### `fetch_and_filter` returns full page content

That means `OPENROUTER_API_KEY` is not set. The tool still works, but it skips LLM filtering.

### Google results stop parsing correctly

Google changes its DOM often. If that happens, update the selectors in `chrome-extension/background.js`.

## Security Notes

- Bridge requests require a shared token
- The bridge only listens on `127.0.0.1`
- Search requests are rate-limited
- `fetch_and_filter` blocks localhost and private/internal IP ranges
- Prompt injection is treated as untrusted page content during LLM extraction
- Error messages are sanitized before being returned to clients

## Local Development

```bash
git clone https://github.com/dev-tahir/my-google-search-mcp
cd my-google-search-mcp
npm install
npm run build
npm start
```

For development mode:

```bash
npm run dev
```

## Repo Structure

```text
src/
  bin.ts              CLI entrypoint
  index.ts            MCP server and tool registration
  bridge.ts           local bridge between MCP server and Chrome extension
  fetcher.ts          HTML fetching, cleanup, and Markdown conversion
  llm.ts              OpenRouter integration
  site-search.ts      query-driven extraction and link-following

chrome-extension/
  background.js       Chrome extension service worker
  manifest.json       extension manifest
```

## Publishing Notes

- npm package name: `my-google-search-mcp`
- binary entrypoint: `my-google-search-mcp`
- license: MIT

## License

MIT
