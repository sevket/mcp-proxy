export function log(msg) {
  process.stderr.write(`[mcp-proxy] ${msg}\n`);
}
