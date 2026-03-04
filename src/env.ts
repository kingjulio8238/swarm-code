/**
 * Load env vars into process.env.
 * Must be imported BEFORE any module that reads env vars (e.g. pi-ai).
 *
 * Load order (later wins):
 *   1. ~/.rlm/credentials  — persistent keys saved by first-run setup
 *   2. .env in package root — local overrides
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

function loadEnvFile(filePath: string): void {
	if (!fs.existsSync(filePath)) return;
	const content = fs.readFileSync(filePath, "utf-8");
	for (const rawLine of content.split("\n")) {
		let trimmed = rawLine.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		// Strip leading "export " (common in .env files)
		if (trimmed.startsWith("export ")) trimmed = trimmed.slice(7);
		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) continue;
		const key = trimmed.slice(0, eqIndex).trim();
		let value = trimmed.slice(eqIndex + 1).trim();
		// Strip matching surrounding quotes ("..." or '...')
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (key && !process.env[key]) {
			process.env[key] = value;
		}
	}
}

// 1. Load persistent credentials (~/.rlm/credentials)
loadEnvFile(path.join(os.homedir(), ".rlm", "credentials"));

// 2. Load .env from package root (local overrides)
const __dir = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.resolve(__dir, "..", ".env"));

// Default model
if (!process.env.RLM_MODEL) {
	process.env.RLM_MODEL = "claude-sonnet-4-6";
}
