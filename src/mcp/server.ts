/**
 * MCP server for swarm-cli.
 *
 * Exposes swarm capabilities as MCP tools that can be called by
 * Claude Code, Cursor, or any MCP-compatible client.
 *
 * Transport: stdio (reads JSON-RPC from stdin, writes to stdout).
 * IMPORTANT: Never use console.log() — it corrupts the MCP protocol.
 * All logging goes to stderr via process.stderr.write().
 *
 * Usage:
 *   swarm mcp                     # Start MCP server
 *   swarm mcp --dir ./my-project  # Start with default directory
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools, killActiveSubprocesses } from "./tools.js";
import { cleanupAllSessions } from "./session.js";

// ── Logging ────────────────────────────────────────────────────────────────

function log(msg: string): void {
	process.stderr.write(`[swarm-mcp] ${msg}\n`);
}

// ── Server ─────────────────────────────────────────────────────────────────

export async function startMcpServer(args: string[]): Promise<void> {
	// Parse --dir from args
	let defaultDir: string | undefined;
	const dirIdx = args.indexOf("--dir");
	if (dirIdx !== -1 && dirIdx + 1 < args.length) {
		defaultDir = args[dirIdx + 1];
	}

	// Create MCP server
	const server = new McpServer(
		{
			name: "swarm-cli",
			version: getVersion(),
		},
		{
			capabilities: {
				tools: {},
			},
		},
	);

	// Register all tools
	registerTools(server, defaultDir);

	// Handle graceful shutdown — kill subprocesses, cleanup sessions
	const shutdown = async () => {
		log("Shutting down...");
		killActiveSubprocesses();
		await cleanupAllSessions();
		await server.close();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// Connect via stdio transport
	const transport = new StdioServerTransport();
	await server.connect(transport);

	log(`Server started${defaultDir ? ` (default dir: ${defaultDir})` : ""}`);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getVersion(): string {
	try {
		const __dir = dirname(fileURLToPath(import.meta.url));
		const pkgPath = join(__dir, "..", "..", "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		return pkg.version || "0.1.0";
	} catch {
		return "0.1.0";
	}
}
