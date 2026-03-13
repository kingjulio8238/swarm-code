/**
 * Codex CLI agent backend (OpenAI).
 *
 * Runs tasks via `codex --quiet --approval-mode full-auto "prompt"` subprocess.
 * Codex CLI is OpenAI's open-source coding agent.
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
		// Codex uses OPENAI_API_KEY
		OPENAI_API_KEY: process.env.OPENAI_API_KEY,
		// May also need these for provider flexibility
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
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

/** Map provider/model format to codex model flag. */
function resolveModel(model: string): string {
	// Strip provider prefix (e.g., "openai/o3" → "o3")
	const modelName = model.includes("/") ? model.split("/").pop()! : model;
	return modelName;
}

const codexProvider: AgentProvider = {
	name: "codex",

	async isAvailable(): Promise<boolean> {
		return commandExists("codex");
	},

	async run(options: AgentRunOptions): Promise<AgentResult> {
		const { task, workDir, model, files, signal } = options;
		const startTime = Date.now();

		const args = [
			"--quiet",
			"--approval-mode", "full-auto",
		];

		if (model) {
			args.push("--model", resolveModel(model));
		}

		// Build the prompt — include file hints if provided
		let prompt = task;
		if (files && files.length > 0) {
			prompt += `\n\nRelevant files to focus on:\n${files.map(f => `- ${f}`).join("\n")}`;
		}
		args.push(prompt);

		return new Promise<AgentResult>((resolve) => {
			const proc = spawn("codex", args, {
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

				// Codex outputs plain text — extract any file change indicators
				const filesChanged: string[] = [];

				// Codex mentions files it edits in its output
				const editPatterns = [
					/(?:wrote|created|modified|updated|edited)\s+`?([^\s`]+\.\w+)`?/gi,
					/(?:writing to|saving)\s+`?([^\s`]+\.\w+)`?/gi,
				];
				for (const pattern of editPatterns) {
					let match;
					while ((match = pattern.exec(stdout)) !== null) {
						filesChanged.push(match[1]);
					}
				}

				doResolve({
					success: code === 0,
					output: stdout || stderr,
					filesChanged: [...new Set(filesChanged)],
					diff: "", // Diff is captured separately by worktree manager
					durationMs,
					error: code !== 0 ? `codex exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}` : undefined,
				});
			});

			proc.on("error", (err) => {
				doResolve({
					success: false,
					output: "",
					filesChanged: [],
					diff: "",
					durationMs: Date.now() - startTime,
					error: `Failed to spawn codex: ${err.message}`,
				});
			});
		});
	},
};

registerAgent(codexProvider);
export default codexProvider;
