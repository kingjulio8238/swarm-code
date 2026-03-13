/**
 * Thread manager — spawns and manages coding agent threads in isolated worktrees.
 *
 * Each thread:
 *   1. Gets a git worktree
 *   2. Runs an agent (OpenCode by default) in that worktree
 *   3. Captures diff + output
 *   4. Compresses result
 *   5. Returns compressed result to the orchestrator
 */

import { randomBytes } from "node:crypto";
import type { CompressedResult, SwarmConfig, ThreadConfig, ThreadState } from "../core/types.js";
import { getAgent } from "../agents/provider.js";
import { WorktreeManager } from "../worktree/manager.js";
import { compressResult } from "../compression/compressor.js";

export class ThreadManager {
	private threads: Map<string, ThreadState> = new Map();
	private activeCount: number = 0;
	private totalSpawned: number = 0;
	private worktreeManager: WorktreeManager;
	private config: SwarmConfig;
	private onThreadProgress?: (threadId: string, status: string) => void;

	constructor(
		repoRoot: string,
		config: SwarmConfig,
		onThreadProgress?: (threadId: string, status: string) => void,
	) {
		this.config = config;
		this.worktreeManager = new WorktreeManager(repoRoot, config.worktree_base_dir);
		this.onThreadProgress = onThreadProgress;
	}

	async init(): Promise<void> {
		await this.worktreeManager.init();
	}

	/**
	 * Spawn a thread — creates a worktree, runs the agent, returns compressed result.
	 */
	async spawnThread(threadConfig: ThreadConfig): Promise<CompressedResult> {
		// Enforce limits
		if (this.totalSpawned >= this.config.max_total_threads) {
			return {
				success: false,
				summary: `Thread limit reached (${this.config.max_total_threads} max per session)`,
				filesChanged: [],
				diffStats: "",
				durationMs: 0,
			};
		}

		// Wait for a slot if at max concurrency
		while (this.activeCount >= this.config.max_threads) {
			await new Promise((resolve) => setTimeout(resolve, 500));
		}

		const threadId = threadConfig.id || randomBytes(6).toString("hex");
		const state: ThreadState = {
			id: threadId,
			config: threadConfig,
			status: "pending",
			startedAt: Date.now(),
		};
		this.threads.set(threadId, state);
		this.totalSpawned++;
		this.activeCount++;

		try {
			state.status = "running";
			this.onThreadProgress?.(threadId, "creating worktree");

			// Create worktree
			const wtInfo = await this.worktreeManager.create(threadId);
			state.worktreePath = wtInfo.path;
			state.branchName = wtInfo.branch;

			this.onThreadProgress?.(threadId, "running agent");

			// Get agent
			const agent = getAgent(threadConfig.agent.backend || this.config.default_agent);

			// Build the task prompt with context
			let fullTask = threadConfig.task;
			if (threadConfig.context) {
				fullTask = `Context:\n${threadConfig.context}\n\nTask:\n${threadConfig.task}`;
			}

			// Run agent with timeout
			const timeoutSignal = AbortSignal.timeout(this.config.thread_timeout_ms);
			const agentResult = await agent.run({
				task: fullTask,
				workDir: wtInfo.path,
				model: threadConfig.agent.model || this.config.default_model,
				files: threadConfig.files,
				signal: timeoutSignal,
			});

			this.onThreadProgress?.(threadId, "capturing diff");

			// Capture diff and changes
			const diff = await this.worktreeManager.getDiff(threadId);
			const diffStats = await this.worktreeManager.getDiffStats(threadId);
			const filesChanged = await this.worktreeManager.getChangedFiles(threadId);

			// Commit changes in worktree
			if (filesChanged.length > 0) {
				await this.worktreeManager.commit(threadId, `swarm: ${threadConfig.task.slice(0, 72)}`);
			}

			this.onThreadProgress?.(threadId, "compressing result");

			// Compress
			const compressed = compressResult(
				{
					agentOutput: agentResult.output,
					diff,
					diffStats,
					filesChanged,
					success: agentResult.success,
					durationMs: agentResult.durationMs,
					error: agentResult.error,
				},
				this.config.compression_strategy,
				this.config.compression_max_tokens,
			);

			const result: CompressedResult = {
				success: agentResult.success,
				summary: compressed,
				filesChanged,
				diffStats,
				durationMs: Date.now() - state.startedAt!,
			};

			state.status = "completed";
			state.result = result;
			state.completedAt = Date.now();
			this.onThreadProgress?.(threadId, "completed");

			return result;
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			state.status = "failed";
			state.error = errorMsg;
			state.completedAt = Date.now();
			this.onThreadProgress?.(threadId, `failed: ${errorMsg}`);

			return {
				success: false,
				summary: `Thread failed: ${errorMsg}`,
				filesChanged: [],
				diffStats: "",
				durationMs: Date.now() - (state.startedAt || Date.now()),
			};
		} finally {
			this.activeCount--;
		}
	}

	/** Get all thread states. */
	getThreads(): ThreadState[] {
		return [...this.threads.values()];
	}

	/** Get a specific thread's state. */
	getThread(threadId: string): ThreadState | undefined {
		return this.threads.get(threadId);
	}

	/** Get the worktree manager for merge operations. */
	getWorktreeManager(): WorktreeManager {
		return this.worktreeManager;
	}

	/** Cleanup all worktrees. */
	async cleanup(): Promise<void> {
		if (this.config.auto_cleanup_worktrees) {
			await this.worktreeManager.destroyAll();
		}
	}
}
