// Multi-process bridge test
import { startBridge, isExtensionConnected } from './dist/bridge.js';
import http from 'http';
import { spawn } from 'child_process';

const PORT = 3778;

// ── Process 1: owner
console.log('=== Process 1: starting bridge on port', PORT, '===');
await startBridge(PORT);
console.log('Process 1 isExtensionConnected (no polls):', await isExtensionConnected());

// Simulate one extension poll so extensionLastSeen updates
await new Promise(r => {
  http.get(`http://127.0.0.1:${PORT}/pending?token=mcp-local-dev`, res => { res.resume(); res.on('end', r); });
});
console.log('Process 1 isExtensionConnected (after poll):', await isExtensionConnected());

// ── Process 2: simulate second VS Code session (non-owner)
const child = spawn(process.execPath, ['--input-type=module'], {
  stdio: ['pipe', 'inherit', 'inherit'],
  env: { ...process.env, PORT: String(PORT) },
});

child.stdin.write(`
import { startBridge, isExtensionConnected } from './dist/bridge.js';
const port = Number(process.env.PORT);
await startBridge(port);
const connected = await isExtensionConnected();
console.log('[Process 2] isExtensionConnected:', connected, connected ? '✅ PASS' : '❌ FAIL');
process.exit(connected ? 0 : 1);
`);
child.stdin.end();

child.on('exit', code => {
  console.log('[Process 2] exited with code', code);
  process.exit(0);
});
