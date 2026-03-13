/**
 * OpenCode agent backend.
 *
 * Runs tasks via `opencode run --format json "prompt"` subprocess.
 * Parses JSON output for structured results.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
				env: { ...process.env },
			});

			let stdout = "";
			let stderr = "";

			proc.stdout?.on("data", (chunk: Buffer) => {
				const text = chunk.toString();
				stdout += text;
				options.onOutput?.(text);
			});

			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			if (signal) {
				signal.addEventListener("abort", () => {
					proc.kill("SIGTERM");
				}, { once: true });
			}

			proc.on("close", (code) => {
				const durationMs = Date.now() - startTime;

				// Try to parse JSON output
				let filesChanged: string[] = [];
				let output = stdout;

				try {
					const parsed = JSON.parse(stdout) as OpenCodeJsonOutput;
					if (parsed.error) {
						resolve({
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
				} catch {
					// Not valid JSON — use raw stdout
					output = stdout;
				}

				// Deduplicate files
				filesChanged = [...new Set(filesChanged)];

				resolve({
					success: code === 0,
					output,
					filesChanged,
					diff: "", // Diff is captured separately by worktree manager
					durationMs,
					error: code !== 0 ? `opencode exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}` : undefined,
				});
			});

			proc.on("error", (err) => {
				resolve({
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
