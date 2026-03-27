#!/usr/bin/env node
// bin.ts — npx entry point for my-google-search-mcp
// Handles first-run token display then delegates to the MCP server

import "dotenv/config";
import { randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Token resolution ──────────────────────────────────────────────────────────
// Priority: BRIDGE_TOKEN env var → stored token in ~/.mcp-google-search → random generated
const CONFIG_PATH = join(homedir(), ".mcp-google-search.json");

function loadOrCreateToken(): { token: string; isNew: boolean } {
  // 1. Env var takes top priority
  if (process.env.BRIDGE_TOKEN) {
    return { token: process.env.BRIDGE_TOKEN, isNew: false };
  }

  // 2. Persisted token from previous run
  if (existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as { token?: string };
      if (cfg.token) {
        process.env.BRIDGE_TOKEN = cfg.token;
        return { token: cfg.token, isNew: false };
      }
    } catch { /* corrupt config — regenerate */ }
  }

  // 3. Generate a new random token and persist it
  const token = randomBytes(16).toString("hex");
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({ token }, null, 2), "utf-8");
  } catch {
    // If we can't write (e.g. permissions), just use for this session
  }
  process.env.BRIDGE_TOKEN = token;
  return { token, isNew: true };
}

const { token, isNew } = loadOrCreateToken();

// ─── Print startup banner to stderr (visible in MCP client logs) ──────────────
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const CYAN   = "\x1b[36m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";

process.stderr.write(`
${BOLD}${CYAN}╔══════════════════════════════════════════════════════╗
║          My Google Search MCP  — Starting up        ║
╚══════════════════════════════════════════════════════╝${RESET}

${BOLD}Bridge Token:${RESET}  ${GREEN}${token}${RESET}${isNew ? `  ${YELLOW}(new — saved to ${CONFIG_PATH})${RESET}` : ""}

${BOLD}Chrome Extension Setup:${RESET}
  1. Load the ${BOLD}chrome-extension/${RESET} folder in Chrome (chrome://extensions → Load unpacked)
  2. Open ${BOLD}chrome-extension/background.js${RESET} and set:
       ${CYAN}const BRIDGE_TOKEN = "${token}";${RESET}
  3. Leave the token blank nowhere else — the extension will refuse to run with a default token.
  4. Click "Update" on the extension page

  Or set ${BOLD}BRIDGE_TOKEN${RESET} env var before running to use a custom token.
  Delete ${BOLD}${CONFIG_PATH}${RESET} to generate a new token.

`);

// ─── Start the MCP server ─────────────────────────────────────────────────────
// Dynamic import so token is in process.env before server code loads
import("./index.js").catch((err: unknown) => {
  console.error("Fatal error starting MCP server:", err);
  process.exit(1);
});
