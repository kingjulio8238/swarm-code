/**
 * Swarm mode — orchestrates coding agents in parallel via the RLM loop.
 *
 * Usage: swarm --dir ./my-project "add error handling to all API routes"
 *
 * This module:
 *   1. Parses swarm-specific CLI args
 *   2. Scans the target directory to build a codebase context
 *   3. Sets up ThreadManager + WorktreeManager
 *   4. Runs the RLM loop with the swarm orchestrator prompt
 *   5. Cleans up worktrees on exit
 */

import "./env.js";
import * as fs from "node:fs";
import * as path from "node:path";

// Dynamic imports — ensures env.js has set process.env BEFORE pi-ai loads
const { getModels, getProviders } = await import("@mariozechner/pi-ai");
const { PythonRepl } = await import("./core/repl.js");
const { runRlmLoop } = await import("./core/rlm.js");
const { loadConfig } = await import("./config.js");

// Register agent backends
await import("./agents/opencode.js");
await import("./agents/direct-llm.js");
await import("./agents/claude-code.js");
await import("./agents/codex.js");
await import("./agents/aider.js");

import { randomBytes } from "node:crypto";
import { ThreadManager, type ThreadProgressCallback } from "./threads/manager.js";
import { mergeAllThreads, type MergeAllOptions } from "./worktree/merge.js";
import { buildSwarmSystemPrompt } from "./prompts/orchestrator.js";
import { routeTask, classifyTaskSlot, classifyTaskComplexity, describeAvailableAgents } from "./routing/model-router.js";
import { EpisodicMemory } from "./memory/episodic.js";
import type { ThreadProgressPhase } from "./core/types.js";
import type { Api, Model } from "@mariozechner/pi-ai";

// ── Arg parsing ─────────────────────────────────────────────────────────────

interface SwarmArgs {
	dir: string;
	orchestratorModel: string;
	agent: string;
	dryRun: boolean;
	maxBudget: number | null;
	verbose: boolean;
	autoRoute: boolean;
	query: string;
}

function parseSwarmArgs(args: string[]): SwarmArgs {
	let dir = "";
	let orchestratorModel = "";
	let agent = "";
	let dryRun = false;
	let maxBudget: number | null = null;
	let verbose = false;
	let autoRoute = false;
	const positional: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--dir" && i + 1 < args.length) {
			dir = args[++i];
		} else if (arg === "--orchestrator" && i + 1 < args.length) {
			orchestratorModel = args[++i];
		} else if (arg === "--agent" && i + 1 < args.length) {
			agent = args[++i];
		} else if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--max-budget" && i + 1 < args.length) {
			const parsed = parseFloat(args[++i]);
			maxBudget = isFinite(parsed) && parsed > 0 ? parsed : null;
		} else if (arg === "--verbose") {
			verbose = true;
		} else if (arg === "--auto-route") {
			autoRoute = true;
		} else if (!arg.startsWith("--")) {
			positional.push(arg);
		}
	}

	if (!dir) {
		console.error("Error: --dir <path> is required for swarm mode");
		process.exit(1);
	}

	if (positional.length === 0) {
		console.error("Error: query argument is required");
		console.error('Usage: swarm --dir ./project "your task description"');
		process.exit(1);
	}

	return {
		dir: path.resolve(dir),
		orchestratorModel: orchestratorModel || process.env.RLM_MODEL || "claude-sonnet-4-6",
		agent: agent || "",
		dryRun,
		maxBudget,
		autoRoute,
		verbose,
		query: positional.join(" "),
	};
}

// ── Codebase scanning ───────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
	"node_modules", ".git", "dist", "build", ".next", ".venv", "venv",
	"__pycache__", ".swarm-worktrees", "coverage", ".turbo", ".cache",
]);

const SKIP_EXTENSIONS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".woff", ".woff2",
	".ttf", ".eot", ".mp3", ".mp4", ".webm", ".zip", ".tar", ".gz",
	".lock", ".map",
]);

function scanDirectory(dir: string, maxFiles: number = 200, maxTotalSize: number = 2 * 1024 * 1024): string {
	const files: { relPath: string; content: string }[] = [];
	let totalSize = 0;

	function walk(currentDir: string, depth: number) {
		if (depth > 15 || files.length >= maxFiles || totalSize >= maxTotalSize) return;

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(currentDir, { withFileTypes: true });
		} catch {
			return;
		}

		// Sort for deterministic output
		entries.sort((a, b) => a.name.localeCompare(b.name));

		for (const entry of entries) {
			if (files.length >= maxFiles || totalSize >= maxTotalSize) return;

			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
					walk(path.join(currentDir, entry.name), depth + 1);
				}
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name).toLowerCase();
				if (SKIP_EXTENSIONS.has(ext)) continue;

				const fullPath = path.join(currentDir, entry.name);
				try {
					const stat = fs.statSync(fullPath);
					if (stat.size > 100 * 1024) continue; // Skip files > 100KB
					if (stat.size === 0) continue;

					const content = fs.readFileSync(fullPath, "utf-8");
					// Check for binary content
					if (content.includes("\0")) continue;

					const relPath = path.relative(dir, fullPath);
					files.push({ relPath, content });
					totalSize += content.length;
				} catch {
					continue;
				}
			}
		}
	}

	walk(dir, 0);

	// Build context string
	const parts: string[] = [];
	parts.push(`Codebase: ${path.basename(dir)}`);
	parts.push(`Files: ${files.length}`);
	parts.push(`Total size: ${(totalSize / 1024).toFixed(1)}KB`);
	parts.push("---");

	for (const file of files) {
		parts.push(`\n=== ${file.relPath} ===`);
		parts.push(file.content);
	}

	return parts.join("\n");
}

// ── Model resolution ────────────────────────────────────────────────────────

function resolveModel(modelId: string): { model: Model<Api>; provider: string } | null {
	const providerKeys: Record<string, string> = {
		anthropic: "ANTHROPIC_API_KEY",
		openai: "OPENAI_API_KEY",
		google: "GEMINI_API_KEY",
	};
	const defaultModels: Record<string, string> = {
		anthropic: "claude-sonnet-4-6",
		openai: "gpt-4o",
		google: "gemini-2.5-flash",
	};

	const knownProviders = new Set(Object.keys(providerKeys));
	let model: Model<Api> | undefined;
	let resolvedProvider = "";

	// First pass: known providers with keys
	for (const provider of getProviders()) {
		if (!knownProviders.has(provider)) continue;
		const key = providerKeys[provider]!;
		if (!process.env[key]) continue;
		for (const m of getModels(provider)) {
			if (m.id === modelId) {
				model = m;
				resolvedProvider = provider;
				break;
			}
		}
		if (model) break;
	}

	// Second pass: all providers
	if (!model) {
		for (const provider of getProviders()) {
			if (knownProviders.has(provider)) continue;
			for (const m of getModels(provider)) {
				if (m.id === modelId) {
					model = m;
					resolvedProvider = provider;
					break;
				}
			}
			if (model) break;
		}
	}

	// Fallback: pick any model from a provider that has a key
	if (!model) {
		for (const [prov, envKey] of Object.entries(providerKeys)) {
			if (!process.env[envKey]) continue;
			const fallbackId = defaultModels[prov];
			if (!fallbackId) continue;
			for (const p of getProviders()) {
				if (p !== prov) continue;
				for (const m of getModels(p)) {
					if (m.id === fallbackId) {
						model = m;
						resolvedProvider = prov;
						console.error(`Note: using ${fallbackId} (${prov}) — model "${modelId}" not found`);
						break;
					}
				}
				if (model) break;
			}
			if (model) break;
		}
	}

	if (!model) return null;
	return { model, provider: resolvedProvider };
}

// ── Main ────────────────────────────────────────────────────────────────────

export async function runSwarmMode(rawArgs: string[]): Promise<void> {
	const args = parseSwarmArgs(rawArgs);
	const config = loadConfig();

	// Override config with CLI args
	if (args.agent) config.default_agent = args.agent;
	if (args.maxBudget !== null) config.max_session_budget_usd = args.maxBudget;
	if (args.autoRoute) config.auto_model_selection = true;

	// Verify target directory
	if (!fs.existsSync(args.dir)) {
		console.error(`Error: directory "${args.dir}" does not exist`);
		process.exit(1);
	}

	// Resolve orchestrator model
	const resolved = resolveModel(args.orchestratorModel);
	if (!resolved) {
		console.error(`Error: could not find model "${args.orchestratorModel}"`);
		console.error("Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY in your .env file");
		process.exit(1);
	}

	console.error(`\x1b[36m╔══════════════════════════════════════════╗`);
	console.error(`║           swarm — coding agent           ║`);
	console.error(`╚══════════════════════════════════════════╝\x1b[0m`);
	console.error(`  Directory: ${args.dir}`);
	console.error(`  Model:     ${resolved.model.id} (${resolved.provider})`);
	console.error(`  Agent:     ${config.default_agent}`);
	console.error(`  Routing:   ${config.auto_model_selection ? "auto" : "orchestrator-driven"}`);
	console.error(`  Query:     ${args.query}`);
	if (args.dryRun) console.error(`  Mode:      DRY RUN (no threads will be spawned)`);
	console.error(`---`);

	// Scan codebase
	console.error("Scanning codebase...");
	const context = scanDirectory(args.dir);
	console.error(`Context: ${(context.length / 1024).toFixed(1)}KB`);

	// Start REPL
	const repl = new PythonRepl();
	const ac = new AbortController();

	// Progress callback for thread events
	const threadProgress: ThreadProgressCallback = (threadId, phase, detail) => {
		const tag = threadId.slice(0, 8);
		const phaseLabels: Record<ThreadProgressPhase, string> = {
			queued: "queued",
			creating_worktree: "creating worktree",
			agent_running: "running agent",
			capturing_diff: "capturing diff",
			compressing: "compressing",
			completed: "completed",
			failed: "FAILED",
			cancelled: "cancelled",
			retrying: "retrying",
		};
		const label = phaseLabels[phase] || phase;
		const suffix = detail ? ` (${detail})` : "";
		console.error(`  [thread:${tag}] ${label}${suffix}`);
	};

	// Initialize thread manager with session abort signal
	const threadManager = new ThreadManager(args.dir, config, threadProgress, ac.signal);
	await threadManager.init();

	// Initialize episodic memory if enabled
	let episodicMemory: EpisodicMemory | undefined;
	if (config.episodic_memory_enabled) {
		episodicMemory = new EpisodicMemory(config.memory_dir);
		await episodicMemory.init();
		threadManager.setEpisodicMemory(episodicMemory);
		console.error(`  Memory:   ${episodicMemory.size} episodes loaded from ${config.memory_dir}`);
	}

	const abortAndExit = () => {
		console.error("\nAborting...");
		ac.abort();
	};
	process.on("SIGINT", abortAndExit);
	process.on("SIGTERM", abortAndExit);

	try {
		await repl.start(ac.signal);

		// Register LLM summarizer for llm-summary compression strategy
		if (config.compression_strategy === "llm-summary") {
			const { setSummarizer } = await import("./compression/compressor.js");
			const { completeSimple } = await import("@mariozechner/pi-ai");
			setSummarizer(async (text: string, instruction: string) => {
				const response = await completeSimple(resolved.model, {
					systemPrompt: instruction,
					messages: [{
						role: "user",
						content: text,
						timestamp: Date.now(),
					}],
				});
				// Extract text content from AssistantMessage
				return response.content
					.filter((b): b is { type: "text"; text: string } => b.type === "text")
					.map(b => b.text)
					.join("");
			});
		}

		// Build system prompt with agent capabilities
		const agentDesc = await describeAvailableAgents();
		let systemPrompt = buildSwarmSystemPrompt(config, agentDesc);
		if (args.dryRun) {
			systemPrompt += "\n\n## DRY RUN MODE\nDo NOT call thread() or async_thread(). Instead, describe what threads you WOULD spawn (task, files, model). Call FINAL() with your execution plan.";
		}

		// Add episodic memory hints to system prompt
		if (episodicMemory && episodicMemory.size > 0) {
			const hints = episodicMemory.getStrategyHints(args.query);
			if (hints) {
				systemPrompt += `\n\n## Episodic Memory\n${hints}\nConsider these strategies when decomposing your task.`;
			}
		}

		// Thread handler — wires Python thread() calls to ThreadManager
		const threadHandler = async (
			task: string,
			threadContext: string,
			agentBackend: string,
			model: string,
			files: string[],
		) => {
			let resolvedAgent = agentBackend || config.default_agent;
			let resolvedModel = model || config.default_model;
			let routeSlot = "";
			let routeComplexity = "";

			// Auto-routing: override agent/model if enabled and not explicitly specified
			if (config.auto_model_selection && !agentBackend && !model) {
				const route = await routeTask(task, config, episodicMemory);
				resolvedAgent = route.agent;
				resolvedModel = route.model;
				routeSlot = route.slot;
				routeComplexity = classifyTaskComplexity(task);
				if (args.verbose) {
					const memHints = episodicMemory?.getStrategyHints(task);
					console.error(`  [router] ${route.reason} [slot: ${route.slot}]`);
					if (memHints) console.error(`  [memory] ${memHints.split("\n")[1] || ""}`);
				}
			}

			const threadId = randomBytes(6).toString("hex");
			const result = await threadManager.spawnThread({
				id: threadId,
				task,
				context: threadContext,
				agent: {
					backend: resolvedAgent,
					model: resolvedModel,
				},
				files,
			});

			// Record episode with slot/complexity metadata (supplements the
			// generic recording in ThreadManager with routing-specific info)
			if (episodicMemory && result.success && routeSlot) {
				episodicMemory.record({
					task,
					agent: resolvedAgent,
					model: resolvedModel,
					slot: routeSlot,
					complexity: routeComplexity,
					success: true,
					durationMs: result.durationMs,
					estimatedCostUsd: result.estimatedCostUsd,
					filesChanged: result.filesChanged,
					summary: result.summary,
				}).catch(() => {}); // Non-fatal
			}

			return {
				result: result.summary,
				success: result.success,
				filesChanged: result.filesChanged,
				durationMs: result.durationMs,
			};
		};

		// Merge handler — wires Python merge_threads() to worktree merge
		const mergeHandler = async () => {
			const threads = threadManager.getThreads();
			const mergeOpts: MergeAllOptions = { continueOnConflict: true };
			const results = await mergeAllThreads(args.dir, threads, mergeOpts);

			const summary = results.map((r) =>
				r.success
					? `Merged ${r.branch}: ${r.message}`
					: `FAILED ${r.branch}: ${r.message}`,
			).join("\n");

			return {
				result: summary || "No threads to merge",
				success: results.every((r) => r.success),
			};
		};

		const startTime = Date.now();
		const result = await runRlmLoop({
			context,
			query: args.query,
			model: resolved.model,
			repl,
			signal: ac.signal,
			systemPrompt,
			threadHandler: args.dryRun ? undefined : threadHandler,
			mergeHandler: args.dryRun ? undefined : mergeHandler,
			onProgress: args.verbose
				? (info) => {
						const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
						console.error(
							`[${elapsed}s] Iteration ${info.iteration}/${info.maxIterations} | ` +
								`Sub-queries: ${info.subQueries} | Phase: ${info.phase}`,
						);
					}
				: undefined,
		});

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		console.error("---");
		console.error(
			`Completed in ${elapsed}s | ${result.iterations} iterations | ${result.totalSubQueries} sub-queries | ${result.completed ? "success" : "incomplete"}`,
		);

		const threads = threadManager.getThreads();
		if (threads.length > 0) {
			const completed = threads.filter(t => t.status === "completed").length;
			const failed = threads.filter(t => t.status === "failed").length;
			const cancelled = threads.filter(t => t.status === "cancelled").length;
			const budget = threadManager.getBudgetState();
			let threadSummary = `Threads: ${completed} completed, ${failed} failed`;
			if (cancelled > 0) threadSummary += `, ${cancelled} cancelled`;
			threadSummary += ` | Est. cost: $${budget.totalSpentUsd.toFixed(4)}`;
			console.error(threadSummary);

			// Report cache stats if any cache activity occurred
			const cacheStats = threadManager.getCacheStats();
			if (cacheStats.hits > 0 || cacheStats.size > 0) {
				console.error(
					`Cache: ${cacheStats.hits} hits, ${cacheStats.misses} misses` +
					` | Saved: ${(cacheStats.totalSavedMs / 1000).toFixed(1)}s, $${cacheStats.totalSavedUsd.toFixed(4)}`,
				);
			}

			// Report episodic memory stats
			if (episodicMemory) {
				console.error(`Memory: ${episodicMemory.size} episodes stored`);
			}
		}

		console.error("---");
		console.log(result.answer);
	} finally {
		repl.shutdown();
		await threadManager.cleanup();
	}
}
