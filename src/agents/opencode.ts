/**
 * OpenCode agent backend.
 *
 * Runs tasks via `opencode run --format json "prompt"` subprocess.
 * Parses JSON output for structured results.
 */

import { spawn } from "node:child_process";
import * as os from "node:os";
import type { AgentProvider, AgentRunOptions, AgentResult } from "../core/types.js";
import { registerAgent } from "./provider.js";

async function commandExists(cmd: string): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn("which", [cmd], { stdio: "pipe" });
		proc.on("close", (code) => resolve(code === 0));
		proc.on("error", () => resolve(false));
	});
}

interface OpenCodeJsonOutput {
	session_id?: string;
	messages?: Array<{
		role: string;
		content: string;
		tool_calls?: Array<{ name: string; input: Record<string, unknown> }>;
		tool_results?: Array<{ name: string; output: string }>;
	}>;
	error?: string;
}

/** Extract JSON object from mixed stdout (may contain non-JSON lines before/after). */
function extractJson(raw: string): OpenCodeJsonOutput | null {
	// Try direct parse first (fast path)
	try {
		return JSON.parse(raw) as OpenCodeJsonOutput;
	} catch { /* mixed output — try extraction */ }

	// Find the first { and last } to extract JSON object
	const firstBrace = raw.indexOf("{");
	const lastBrace = raw.lastIndexOf("}");
	if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

	try {
		return JSON.parse(raw.slice(firstBrace, lastBrace + 1)) as OpenCodeJsonOutput;
	} catch {
		return null;
	}
}

/** Whitelist of env vars safe to pass to agent subprocess. */
function buildAgentEnv(): Record<string, string | undefined> {
	const homeDir = os.homedir();
	return {
		PATH: process.env.PATH,
		HOME: homeDir,
		USERPROFILE: homeDir,
		SHELL: process.env.SHELL,
		TERM: process.env.TERM,
		LANG: process.env.LANG,
		// API keys needed by the agent for LLM calls
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
		OPENAI_API_KEY: process.env.OPENAI_API_KEY,
		GEMINI_API_KEY: process.env.GEMINI_API_KEY,
		// Git config
		GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
		GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
		GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
		GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
		// Windows
		...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
		...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
	};
}

const openCodeProvider: AgentProvider = {
	name: "opencode",

	async isAvailable(): Promise<boolean> {
		return commandExists("opencode");
	},

	async run(options: AgentRunOptions): Promise<AgentResult> {
		const { task, workDir, model, signal } = options;
		const startTime = Date.now();

		const args = ["run", "--format", "json"];
		if (model) {
			args.push("--model", model);
		}
		args.push(task);

		return new Promise<AgentResult>((resolve) => {
			const proc = spawn("opencode", args, {
				cwd: workDir,
				stdio: ["pipe", "pipe", "pipe"],
				env: buildAgentEnv(),
			});

			let stdout = "";
			let stderr = "";
			let resolved = false;

			const doResolve = (result: AgentResult) => {
				if (resolved) return;
				resolved = true;
				resolve(result);
			};

			proc.stdout?.on("data", (chunk: Buffer) => {
				const text = chunk.toString();
				stdout += text;
				options.onOutput?.(text);
			});

			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			if (signal) {
				const onAbort = () => {
					proc.kill("SIGTERM");
					// Escalate to SIGKILL after 3s if process doesn't exit
					const killTimer = setTimeout(() => {
						try { if (proc.exitCode === null) proc.kill("SIGKILL"); } catch { /* already dead */ }
					}, 3000);
					proc.on("exit", () => clearTimeout(killTimer));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				proc.on("exit", () => signal.removeEventListener("abort", onAbort));
			}

			proc.on("close", (code) => {
				const durationMs = Date.now() - startTime;

				// Try to parse JSON output (handles mixed non-JSON lines)
				let filesChanged: string[] = [];
				let output = stdout;

				const parsed = extractJson(stdout);
				if (parsed) {
					if (parsed.error) {
						doResolve({
							success: false,
							output: parsed.error,
							filesChanged: [],
							diff: "",
							durationMs,
							error: parsed.error,
						});
						return;
					}

					// Extract the last assistant message as the output
					if (parsed.messages) {
						const assistantMsgs = parsed.messages.filter((m) => m.role === "assistant");
						if (assistantMsgs.length > 0) {
							output = assistantMsgs[assistantMsgs.length - 1].content;
						}

						// Extract file changes from tool calls
						for (const msg of parsed.messages) {
							if (msg.tool_calls) {
								for (const tc of msg.tool_calls) {
									if (tc.name === "write" || tc.name === "edit") {
										const filePath = tc.input.file_path || tc.input.path;
										if (typeof filePath === "string") {
											filesChanged.push(filePath);
										}
									}
								}
							}
						}
					}
				}

				// Deduplicate files
				filesChanged = [...new Set(filesChanged)];

				doResolve({
					success: code === 0,
					output,
					filesChanged,
					diff: "", // Diff is captured separately by worktree manager
					durationMs,
					error: code !== 0 ? `opencode exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}` : undefined,
				});
			});

			proc.on("error", (err) => {
				doResolve({
					success: false,
					output: "",
					filesChanged: [],
					diff: "",
					durationMs: Date.now() - startTime,
					error: `Failed to spawn opencode: ${err.message}`,
				});
			});
		});
	},
};

registerAgent(openCodeProvider);
export default openCodeProvider;
