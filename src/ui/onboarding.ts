/**
 * First-run onboarding — fun welcome screen inspired by Claude Code.
 *
 * Two-column layout: left has greeting + swarm mesh art + version info,
 * right has tips + environment checks. Triggered once on first
 * `swarm --dir` invocation. Saves ~/.swarm/.initialized marker.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { spawn } from "node:child_process";

import {
	bold, coral, cyan, dim, green, red, yellow,
	isTTY, symbols, termWidth, stripAnsi,
} from "./theme.js";
import { isJsonMode, getLogLevel } from "./log.js";

// ── Marker ───────────────────────────────────────────────────────────────────

const SWARM_DIR = path.join(os.homedir(), ".swarm");
const MARKER_FILE = path.join(SWARM_DIR, ".initialized");
const VERSION = "0.1.0";

export function isFirstRun(): boolean {
	return !fs.existsSync(MARKER_FILE);
}

function markInitialized(): void {
	try {
		fs.mkdirSync(SWARM_DIR, { recursive: true });
		fs.writeFileSync(MARKER_FILE, new Date().toISOString() + "\n", "utf-8");
	} catch {
		// Non-fatal — onboarding will just run again next time
	}
}

// ── Dependency checks ────────────────────────────────────────────────────────

interface CheckResult {
	name: string;
	ok: boolean;
	detail: string;
}

async function commandExists(cmd: string): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn("which", [cmd], { stdio: "pipe" });
		proc.on("close", (code) => resolve(code === 0));
		proc.on("error", () => resolve(false));
	});
}

async function gitVersion(): Promise<string | null> {
	return new Promise((resolve) => {
		const proc = spawn("git", ["--version"], { stdio: "pipe" });
		let out = "";
		proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
		proc.on("close", (code) => {
			if (code === 0) {
				const match = out.match(/git version (\S+)/);
				resolve(match ? match[1] : "unknown");
			} else {
				resolve(null);
			}
		});
		proc.on("error", () => resolve(null));
	});
}

function detectApiKeys(): { provider: string; masked: string }[] {
	const keys: { provider: string; masked: string }[] = [];
	const providers: [string, string][] = [
		["Anthropic", "ANTHROPIC_API_KEY"],
		["OpenAI", "OPENAI_API_KEY"],
		["Google", "GEMINI_API_KEY"],
	];
	for (const [name, envVar] of providers) {
		const val = process.env[envVar];
		if (val && val.length > 8) {
			keys.push({ provider: name, masked: val.slice(0, 7) + "..." + val.slice(-4) });
		}
	}
	return keys;
}

async function checkAgentBackends(): Promise<CheckResult[]> {
	const agents: [string, string][] = [
		["opencode", "opencode"],
		["claude", "claude"],
		["codex", "codex"],
		["aider", "aider"],
	];
	const results: CheckResult[] = [];
	for (const [name, cmd] of agents) {
		const exists = await commandExists(cmd);
		results.push({
			name,
			ok: exists,
			detail: exists ? "installed" : "not found",
		});
	}
	return results;
}

// ── API key prompt ───────────────────────────────────────────────────────────

async function promptApiKey(): Promise<{ provider: string; key: string } | null> {
	if (!isTTY) return null;

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stderr,
	});

	const ask = (q: string): Promise<string> => new Promise((resolve) => {
		rl.question(q, (answer) => resolve(answer.trim()));
	});

	process.stderr.write("\n");
	process.stderr.write(`  ${yellow(symbols.warn)} No API keys found.\n`);
	process.stderr.write(`  ${dim("swarm needs at least one LLM provider key to function.")}\n\n`);

	process.stderr.write(`  ${bold("Pick a provider:")}\n`);
	process.stderr.write(`    ${cyan("1")}  Anthropic  ${dim("(recommended)")}\n`);
	process.stderr.write(`    ${cyan("2")}  OpenAI\n`);
	process.stderr.write(`    ${cyan("3")}  Google\n`);
	process.stderr.write(`    ${dim("s")}  ${dim("Skip for now")}\n\n`);

	const choice = await ask(`  ${coral(symbols.arrow)} Choice [1/2/3/s]: `);

	const providerMap: Record<string, [string, string]> = {
		"1": ["Anthropic", "ANTHROPIC_API_KEY"],
		"2": ["OpenAI", "OPENAI_API_KEY"],
		"3": ["Google", "GEMINI_API_KEY"],
	};

	if (!providerMap[choice]) {
		rl.close();
		return null;
	}

	const [provName, envVar] = providerMap[choice];

	// Close readline BEFORE entering raw mode to avoid buffering conflicts
	rl.close();

	process.stderr.write(`\n  ${dim(`Paste your ${provName} API key (input hidden):`)}\n`);

	// Read key with hidden input
	const key = await new Promise<string>((resolve) => {
		let input = "";
		const origRawMode = process.stdin.isRaw;
		if (process.stdin.isTTY) process.stdin.setRawMode(true);

		process.stderr.write(`  ${coral(symbols.arrow)} `);

		const cleanup = () => {
			process.stdin.removeListener("data", onData);
			if (process.stdin.isTTY && origRawMode !== undefined) {
				process.stdin.setRawMode(origRawMode);
			}
			process.stdin.pause();
		};

		const onData = (buf: Buffer) => {
			const ch = buf.toString();
			if (ch === "\n" || ch === "\r") {
				process.stderr.write("\n");
				cleanup();
				resolve(input);
			} else if (ch === "\x7f" || ch === "\b") {
				if (input.length > 0) {
					input = input.slice(0, -1);
					process.stderr.write("\b \b");
				}
			} else if (ch === "\x03") {
				process.stderr.write("\n");
				cleanup();
				resolve("");
			} else if (ch >= " ") {
				input += ch;
				process.stderr.write(dim("*"));
			}
		};
		process.stdin.on("data", onData);
	});

	if (!key || key.length < 10) {
		process.stderr.write(`  ${dim("Skipped — set the key later in .env or ~/.swarm/credentials")}\n`);
		return null;
	}

	// Save to ~/.swarm/credentials
	try {
		fs.mkdirSync(SWARM_DIR, { recursive: true });
		const credFile = path.join(SWARM_DIR, "credentials");
		let existing = "";
		if (fs.existsSync(credFile)) {
			existing = fs.readFileSync(credFile, "utf-8");
			existing = existing.split("\n").filter(l => !l.startsWith(`${envVar}=`)).join("\n");
			if (existing && !existing.endsWith("\n")) existing += "\n";
		}
		fs.writeFileSync(credFile, existing + `${envVar}=${key}\n`, { mode: 0o600 });
	} catch {
		// Fall through — key is still set in process.env below
	}

	process.env[envVar] = key;
	process.stderr.write(`  ${green(symbols.check)} Saved ${provName} key to ${dim("~/.swarm/credentials")}\n`);
	return { provider: provName, key };
}

// ── Swarm mesh art ───────────────────────────────────────────────────────────

const n = (s: string) => cyan(s);   // node
const c = (s: string) => dim(s);    // connection
const o = (s: string) => coral(s);  // orchestrator (center)

/**
 * 7x3 mesh network — the swarm logo.
 * Wide grid of agent nodes with the orchestrator (coral) at center.
 * Renders as ~25 chars wide, 5 lines tall.
 */
function buildSwarmArt(): string[] {
	const COLS = 7;
	const CENTER = 3;

	function nodeRow(showCenter: boolean): string {
		const parts: string[] = [];
		for (let i = 0; i < COLS; i++) {
			if (i > 0) parts.push(c("\u2500\u2500\u2500"));
			parts.push(showCenter && i === CENTER ? o("\u25C6") : n("\u25CF"));
		}
		return parts.join("");
	}

	function diagRow(startBackslash: boolean): string {
		const parts: string[] = [];
		for (let i = 0; i < COLS; i++) {
			parts.push(c("\u2502"));
			if (i < COLS - 1) {
				const back = (i % 2 === 0) === startBackslash;
				parts.push(` ${c(back ? "\u2572" : "\u2571")} `);
			}
		}
		return parts.join("");
	}

	return [
		nodeRow(false),
		diagRow(true),
		nodeRow(true),
		diagRow(false),
		nodeRow(false),
	];
}

const SWARM_ART = buildSwarmArt();

// ── Two-column renderer ──────────────────────────────────────────────────────

function padRight(text: string, width: number): string {
	const visible = stripAnsi(text).length;
	if (visible >= width) return text;
	return text + " ".repeat(width - visible);
}

function renderTwoColumn(left: string[], right: string[], leftWidth: number): void {
	const sep = ` ${dim(symbols.vertLine)} `;
	const maxLines = Math.max(left.length, right.length);
	for (let i = 0; i < maxLines; i++) {
		const l = padRight(left[i] || "", leftWidth);
		const r = right[i] || "";
		process.stderr.write(`${l}${sep}${r}\n`);
	}
}

// ── Onboarding flow ──────────────────────────────────────────────────────────

export async function runOnboarding(): Promise<void> {
	if (!isFirstRun()) return;

	if (isJsonMode()) {
		markInitialized();
		return;
	}

	if (getLogLevel() === "quiet") {
		markInitialized();
		return;
	}

	const w = Math.min(termWidth(), 80);

	// ── Gather environment info ─────────────────────────────────────────
	const username = os.userInfo().username || "there";
	const gitVer = await gitVersion();
	let apiKeys = detectApiKeys();
	const agents = await checkAgentBackends();
	const availableAgents = agents.filter(a => a.ok);

	// ── Header line (like Claude Code's `── Claude Code v2.1.74 ──`) ────
	if (isTTY) {
		const label = ` swarm v${VERSION} `;
		const dashCount = Math.max(0, w - label.length - 4);
		const leftDash = symbols.horizontal.repeat(2);
		const rightDash = symbols.horizontal.repeat(Math.max(0, dashCount));
		process.stderr.write(`\n  ${dim(`${leftDash}${bold(coral(label))}${dim(rightDash)}`)}\n`);
	} else {
		process.stderr.write(`\n  swarm v${VERSION}\n`);
	}

	if (!isTTY) {
		// Simple non-TTY output
		process.stderr.write(`  Welcome to swarm, ${username}!\n\n`);
		process.stderr.write(`  Usage: swarm --dir ./project "your task"\n`);
		process.stderr.write(`  Docs:  https://github.com/kingjulio8238/swarm-code\n\n`);
		markInitialized();
		return;
	}

	// ── Build left column ───────────────────────────────────────────────
	const LEFT_W = 36;
	const left: string[] = [];

	left.push(`  ${bold("Welcome to swarm, ")}${bold(coral(username))}${bold("!")}`);
	left.push("");

	// Swarm mesh art (centered in left column)
	for (const artLine of SWARM_ART) {
		const artVisible = stripAnsi(artLine).length;
		const artPad = Math.max(0, Math.floor((LEFT_W - artVisible) / 2));
		left.push(" ".repeat(artPad) + artLine);
	}

	left.push("");
	const agentName = availableAgents.length > 0 ? availableAgents[0].name : "opencode";
	left.push(`  ${dim(`v${VERSION}`)} ${dim(symbols.dot)} ${dim(`${agentName} agent`)}`);
	left.push(`  ${dim(process.cwd())}`);

	// ── Build right column ──────────────────────────────────────────────
	const right: string[] = [];

	right.push(coral(bold("Tips for getting started")));
	right.push(`Point swarm at any git repo with a task:`);
	right.push(`${yellow("$")} swarm --dir ./project ${dim('"your task"')}`);
	right.push(`Use ${cyan("--dry-run")} to plan without executing`);
	right.push(`Use ${cyan("--verbose")} for detailed progress`);
	right.push("");

	right.push(coral(bold("Environment")));

	// Git
	if (gitVer) {
		right.push(`${green(symbols.check)} git ${dim(`v${gitVer}`)}`);
	} else {
		right.push(`${red(symbols.cross)} git ${dim("not found (required)")}`);
	}

	// API keys
	if (apiKeys.length > 0) {
		for (const k of apiKeys) {
			right.push(`${green(symbols.check)} ${k.provider} ${dim(k.masked)}`);
		}
	} else {
		right.push(`${yellow(symbols.warn)} ${dim("No API keys configured")}`);
	}

	// Agent backends
	if (availableAgents.length > 0) {
		for (const a of availableAgents) {
			right.push(`${green(symbols.check)} ${a.name} ${dim("agent")}`);
		}
	} else {
		right.push(`${yellow(symbols.warn)} ${dim("No agent backends found")}`);
	}

	// ── Render two-column layout ────────────────────────────────────────
	renderTwoColumn(left, right, LEFT_W);

	// ── API key prompt (if needed, shown below the two columns) ─────────
	if (apiKeys.length === 0) {
		const result = await promptApiKey();
		if (result) {
			apiKeys = detectApiKeys();
		}
	}

	// If still no keys after prompt, show manual instructions
	if (apiKeys.length === 0) {
		process.stderr.write("\n");
		process.stderr.write(`  ${bold("To get started, set an API key:")}\n`);
		process.stderr.write(`  ${dim("Add to")} ${cyan("~/.swarm/credentials")} ${dim("or")} ${cyan(".env")}${dim(":")}\n`);
		process.stderr.write(`    ${dim("ANTHROPIC_API_KEY=sk-ant-...")}\n`);
	}

	// Missing agent hint
	if (availableAgents.length === 0) {
		process.stderr.write(`\n  ${dim("Install an agent:")} npm i -g opencode ${dim("(recommended)")}\n`);
	}

	// ── Footer ──────────────────────────────────────────────────────────
	process.stderr.write("\n");

	markInitialized();
}
