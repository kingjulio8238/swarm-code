/**
 * Aider agent backend.
 *
 * Runs tasks via `aider --yes --no-auto-commits --message "prompt"` subprocess.
 * Aider is a git-aware AI coding assistant that makes targeted edits.
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
		// Aider supports multiple providers via these keys
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
		OPENAI_API_KEY: process.env.OPENAI_API_KEY,
		GEMINI_API_KEY: process.env.GEMINI_API_KEY,
		// Aider-specific env vars
		AIDER_MODEL: process.env.AIDER_MODEL,
		AIDER_DARK_MODE: process.env.AIDER_DARK_MODE,
		// Git config
		GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
		GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
		GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
		GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
		// Python (aider is Python-based)
		VIRTUAL_ENV: process.env.VIRTUAL_ENV,
		CONDA_DEFAULT_ENV: process.env.CONDA_DEFAULT_ENV,
		PYTHONPATH: process.env.PYTHONPATH,
		// Windows
		...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
		...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
	};
}

/** Map provider/model format to aider model flag. */
function resolveModel(model: string): string {
	// Aider accepts provider/model format natively (e.g., "anthropic/claude-sonnet-4-6")
	// so we can pass it through directly
	return model;
}

/** Parse aider output to extract edited file paths. */
function extractFilesChanged(output: string): string[] {
	const files: string[] = [];

	// Aider outputs lines like:
	//   "Applied edit to src/auth.ts"
	//   "Wrote src/auth.ts"
	//   "Committing src/auth.ts ..."
	const patterns = [
		/Applied edit to\s+(.+?)(?:\s*$)/gm,
		/Wrote\s+(.+?)(?:\s*$)/gm,
		/Committing\s+(.+?)(?:\s+\.\.\.|\s*$)/gm,
		/(?:Created|Added)\s+new file\s+(.+?)(?:\s*$)/gm,
	];

	for (const pattern of patterns) {
		let match;
		while ((match = pattern.exec(output)) !== null) {
			const file = match[1].trim();
			if (file && !file.includes(" ")) {
				files.push(file);
			}
		}
	}

	return [...new Set(files)];
}

const aiderProvider: AgentProvider = {
	name: "aider",

	async isAvailable(): Promise<boolean> {
		return commandExists("aider");
	},

	async run(options: AgentRunOptions): Promise<AgentResult> {
		const { task, workDir, model, files, signal } = options;
		const startTime = Date.now();

		const args = [
			"--yes",            // Auto-confirm all prompts
			"--no-auto-commits", // Don't auto-commit (worktree manager handles commits)
			"--no-git",          // Don't use git features (we manage worktrees ourselves)
			"--no-pretty",       // Disable pretty output for cleaner parsing
			"--no-stream",       // Don't stream (capture full output)
		];

		if (model) {
			args.push("--model", resolveModel(model));
		}

		// Pass the task via --message (non-interactive mode)
		args.push("--message", task);

		// Add specific files to edit if provided
		if (files && files.length > 0) {
			for (const file of files) {
				args.push(file);
			}
		}

		return new Promise<AgentResult>((resolve) => {
			const proc = spawn("aider", args, {
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
				const filesChanged = extractFilesChanged(stdout);

				doResolve({
					success: code === 0,
					output: stdout || stderr,
					filesChanged,
					diff: "", // Diff is captured separately by worktree manager
					durationMs,
					error: code !== 0 ? `aider exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}` : undefined,
				});
			});

			proc.on("error", (err) => {
				doResolve({
					success: false,
					output: "",
					filesChanged: [],
					diff: "",
					durationMs: Date.now() - startTime,
					error: `Failed to spawn aider: ${err.message}`,
				});
			});
		});
	},
};

registerAgent(aiderProvider);
export default aiderProvider;
