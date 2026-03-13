/**
 * Thread manager — spawns and manages coding agent threads in isolated worktrees.
 *
 * Phase 2 enhancements:
 *   - AsyncSemaphore for proper concurrency gating (no polling)
 *   - AbortSignal propagation for thread cancellation
 *   - Per-thread retry logic (configurable 0-3 retries)
 *   - Budget tracking and enforcement
 *   - Per-thread error isolation
 */

import { randomBytes } from "node:crypto";
import type {
	BudgetState,
	CompressedResult,
	MODEL_PRICING,
	SwarmConfig,
	ThreadConfig,
	ThreadProgressPhase,
	ThreadState,
} from "../core/types.js";
import { MODEL_PRICING as PRICING } from "../core/types.js";
import { getAgent } from "../agents/provider.js";
import { WorktreeManager } from "../worktree/manager.js";
import { compressResult } from "../compression/compressor.js";

// ── Async Semaphore ─────────────────────────────────────────────────────────

/**
 * Promise-based semaphore for concurrency control.
 * acquire() resolves when a slot is available, release() frees a slot.
 */
class AsyncSemaphore {
	private current: number = 0;
	private readonly max: number;
	private waiters: Array<() => void> = [];

	constructor(max: number) {
		this.max = max;
	}

	async acquire(): Promise<void> {
		if (this.current < this.max) {
			this.current++;
			return;
		}
		await new Promise<void>((resolve) => {
			this.waiters.push(resolve);
		});
		this.current++;
	}

	release(): void {
		if (this.current <= 0) return; // Guard against double-release
		this.current--;
		const next = this.waiters.shift();
		if (next) next();
	}

	get activeCount(): number {
		return this.current;
	}

	get waitingCount(): number {
		return this.waiters.length;
	}
}

// ── Budget Tracker ──────────────────────────────────────────────────────────

class BudgetTracker {
	private totalSpent: number = 0;
	private threadCosts: Map<string, number> = new Map();
	private sessionLimit: number;
	private perThreadLimit: number;

	constructor(sessionLimit: number, perThreadLimit: number) {
		this.sessionLimit = sessionLimit;
		this.perThreadLimit = perThreadLimit;
	}

	/** Estimate cost for a thread based on model and assumed token usage. */
	estimateThreadCost(model: string): number {
		// Extract model name from provider/model format
		const modelName = model.includes("/") ? model.split("/").pop()! : model;
		const pricing = PRICING[modelName];
		if (!pricing) return 0.05; // Default estimate if model unknown

		// Assume ~4K input tokens, ~2K output tokens per thread execution
		const inputTokens = 4000;
		const outputTokens = 2000;
		return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
	}

	/** Check if we can afford to spawn a thread. */
	canAfford(model: string): { allowed: boolean; reason?: string } {
		const estimate = this.estimateThreadCost(model);

		if (this.totalSpent + estimate > this.sessionLimit) {
			return {
				allowed: false,
				reason: `Session budget exceeded: $${this.totalSpent.toFixed(4)} spent of $${this.sessionLimit.toFixed(2)} limit (next thread ~$${estimate.toFixed(4)})`,
			};
		}

		if (estimate > this.perThreadLimit) {
			return {
				allowed: false,
				reason: `Thread cost estimate ($${estimate.toFixed(4)}) exceeds per-thread limit ($${this.perThreadLimit.toFixed(2)})`,
			};
		}

		return { allowed: true };
	}

	/** Record cost for a completed thread. */
	recordCost(threadId: string, cost: number): void {
		this.threadCosts.set(threadId, cost);
		this.totalSpent += cost;
	}

	get spent(): number {
		return this.totalSpent;
	}

	getState(): BudgetState {
		return {
			totalSpentUsd: this.totalSpent,
			threadCosts: new Map(this.threadCosts),
			sessionLimitUsd: this.sessionLimit,
			perThreadLimitUsd: this.perThreadLimit,
		};
	}
}

// ── Thread Manager ──────────────────────────────────────────────────────────

export type ThreadProgressCallback = (threadId: string, phase: ThreadProgressPhase, detail?: string) => void;

export class ThreadManager {
	private threads: Map<string, ThreadState> = new Map();
	private totalSpawned: number = 0;
	private semaphore: AsyncSemaphore;
	private worktreeManager: WorktreeManager;
	private config: SwarmConfig;
	private budget: BudgetTracker;
	private onThreadProgress?: ThreadProgressCallback;
	private sessionAbort?: AbortSignal;
	private threadAbortControllers: Map<string, AbortController> = new Map();

	constructor(
		repoRoot: string,
		config: SwarmConfig,
		onThreadProgress?: ThreadProgressCallback,
		sessionAbort?: AbortSignal,
	) {
		this.config = config;
		this.semaphore = new AsyncSemaphore(config.max_threads);
		this.worktreeManager = new WorktreeManager(repoRoot, config.worktree_base_dir);
		this.budget = new BudgetTracker(config.max_session_budget_usd, config.max_thread_budget_usd);
		this.onThreadProgress = onThreadProgress;
		this.sessionAbort = sessionAbort;
	}

	async init(): Promise<void> {
		await this.worktreeManager.init();
	}

	/**
	 * Spawn a thread — creates a worktree, runs the agent, returns compressed result.
	 * Retries up to config.thread_retries times on failure.
	 * Error-isolated: a failure here never throws — always returns a CompressedResult.
	 */
	async spawnThread(threadConfig: ThreadConfig): Promise<CompressedResult> {
		// Enforce total thread limit
		if (this.totalSpawned >= this.config.max_total_threads) {
			return {
				success: false,
				summary: `Thread limit reached (${this.config.max_total_threads} max per session)`,
				filesChanged: [],
				diffStats: "",
				durationMs: 0,
				estimatedCostUsd: 0,
			};
		}

		// Check budget
		const model = threadConfig.agent.model || this.config.default_model;
		const budgetCheck = this.budget.canAfford(model);
		if (!budgetCheck.allowed) {
			return {
				success: false,
				summary: `Budget exceeded: ${budgetCheck.reason}`,
				filesChanged: [],
				diffStats: "",
				durationMs: 0,
				estimatedCostUsd: 0,
			};
		}

		// Check session abort
		if (this.sessionAbort?.aborted) {
			return {
				success: false,
				summary: "Session aborted",
				filesChanged: [],
				diffStats: "",
				durationMs: 0,
				estimatedCostUsd: 0,
			};
		}

		const threadId = threadConfig.id || randomBytes(6).toString("hex");
		const maxAttempts = this.config.thread_retries + 1;
		const state: ThreadState = {
			id: threadId,
			config: threadConfig,
			status: "pending",
			phase: "queued",
			startedAt: Date.now(),
			attempt: 0,
			maxAttempts,
			estimatedCostUsd: 0,
		};
		this.threads.set(threadId, state);
		this.totalSpawned++;

		// Create per-thread abort controller (linked to session abort)
		const threadAc = new AbortController();
		this.threadAbortControllers.set(threadId, threadAc);
		if (this.sessionAbort) {
			this.sessionAbort.addEventListener("abort", () => threadAc.abort(), { once: true });
		}

		// Retry loop
		let lastResult: CompressedResult | undefined;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			state.attempt = attempt;

			if (attempt > 1) {
				state.phase = "retrying";
				this.onThreadProgress?.(threadId, "retrying", `attempt ${attempt}/${maxAttempts}`);
			}

			lastResult = await this.executeThread(threadId, threadConfig, state, threadAc.signal);

			if (lastResult.success || threadAc.signal.aborted) {
				break;
			}

			// Don't retry on cancellation or budget issues
			if (state.status === "cancelled") break;
		}

		this.threadAbortControllers.delete(threadId);
		return lastResult!;
	}

	/**
	 * Execute a single thread attempt. Acquires semaphore, creates worktree,
	 * runs agent, captures diff, compresses result.
	 */
	private async executeThread(
		threadId: string,
		threadConfig: ThreadConfig,
		state: ThreadState,
		signal: AbortSignal,
	): Promise<CompressedResult> {
		// Wait for a concurrency slot
		state.phase = "queued";
		this.onThreadProgress?.(threadId, "queued",
			this.semaphore.waitingCount > 0 ? `waiting (${this.semaphore.waitingCount} ahead)` : undefined);

		await this.semaphore.acquire();

		try {
			if (signal.aborted) {
				state.status = "cancelled";
				state.phase = "cancelled";
				state.completedAt = Date.now();
				return this.failResult(state, "Thread cancelled before start");
			}

			state.status = "running";

			// Create worktree
			state.phase = "creating_worktree";
			this.onThreadProgress?.(threadId, "creating_worktree");
			const wtInfo = await this.worktreeManager.create(threadId);
			state.worktreePath = wtInfo.path;
			state.branchName = wtInfo.branch;

			// Run agent
			state.phase = "agent_running";
			this.onThreadProgress?.(threadId, "agent_running");
			const agent = getAgent(threadConfig.agent.backend || this.config.default_agent);

			let fullTask = threadConfig.task;
			if (threadConfig.context) {
				fullTask = `Context:\n${threadConfig.context}\n\nTask:\n${threadConfig.task}`;
			}

			// Combine thread timeout with cancellation signal
			const timeoutSignal = AbortSignal.timeout(this.config.thread_timeout_ms);
			const combinedAc = new AbortController();
			const onAbort = () => combinedAc.abort();
			signal.addEventListener("abort", onAbort, { once: true });
			timeoutSignal.addEventListener("abort", onAbort, { once: true });

			let agentResult;
			try {
				agentResult = await agent.run({
					task: fullTask,
					workDir: wtInfo.path,
					model: threadConfig.agent.model || this.config.default_model,
					files: threadConfig.files,
					signal: combinedAc.signal,
				});
			} finally {
				signal.removeEventListener("abort", onAbort);
				// timeoutSignal auto-GCs
			}

			if (signal.aborted) {
				state.status = "cancelled";
				state.phase = "cancelled";
				state.completedAt = Date.now();
				await this.cleanupWorktree(threadId);
				return this.failResult(state, "Thread cancelled during execution");
			}

			// Capture diff
			state.phase = "capturing_diff";
			this.onThreadProgress?.(threadId, "capturing_diff");
			const diff = await this.worktreeManager.getDiff(threadId);
			const diffStats = await this.worktreeManager.getDiffStats(threadId);
			const filesChanged = await this.worktreeManager.getChangedFiles(threadId);

			if (filesChanged.length > 0) {
				await this.worktreeManager.commit(threadId, `swarm: ${threadConfig.task.slice(0, 72)}`);
			}

			// Compress
			state.phase = "compressing";
			this.onThreadProgress?.(threadId, "compressing");
			const compressed = await compressResult(
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

			// Estimate cost and record
			const model = threadConfig.agent.model || this.config.default_model;
			const estimatedCost = this.budget.estimateThreadCost(model);
			this.budget.recordCost(threadId, estimatedCost);
			state.estimatedCostUsd = estimatedCost;

			const result: CompressedResult = {
				success: agentResult.success,
				summary: compressed,
				filesChanged,
				diffStats,
				durationMs: Date.now() - state.startedAt!,
				estimatedCostUsd: estimatedCost,
			};

			state.status = "completed";
			state.phase = "completed";
			state.result = result;
			state.completedAt = Date.now();
			this.onThreadProgress?.(threadId, "completed",
				`${filesChanged.length} files, ~$${estimatedCost.toFixed(4)}`);

			return result;
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			state.status = "failed";
			state.phase = "failed";
			state.error = errorMsg;
			state.completedAt = Date.now();
			this.onThreadProgress?.(threadId, "failed", errorMsg.slice(0, 100));

			// Cleanup worktree on failure
			await this.cleanupWorktree(threadId);

			return this.failResult(state, errorMsg);
		} finally {
			this.semaphore.release();
		}
	}

	/** Cancel a specific running thread. */
	cancelThread(threadId: string): boolean {
		const ac = this.threadAbortControllers.get(threadId);
		if (!ac) return false;
		ac.abort();
		const state = this.threads.get(threadId);
		if (state) {
			state.status = "cancelled";
			state.phase = "cancelled";
		}
		return true;
	}

	/** Cancel all running threads. */
	cancelAll(): void {
		for (const [id, ac] of this.threadAbortControllers) {
			ac.abort();
			const state = this.threads.get(id);
			if (state && state.status === "running") {
				state.status = "cancelled";
				state.phase = "cancelled";
			}
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

	/** Get current budget state. */
	getBudgetState(): BudgetState {
		return this.budget.getState();
	}

	/** Get concurrency stats. */
	getConcurrencyStats(): { active: number; waiting: number; total: number; max: number } {
		return {
			active: this.semaphore.activeCount,
			waiting: this.semaphore.waitingCount,
			total: this.totalSpawned,
			max: this.config.max_threads,
		};
	}

	/** Cleanup all worktrees. */
	async cleanup(): Promise<void> {
		this.cancelAll();
		if (this.config.auto_cleanup_worktrees) {
			await this.worktreeManager.destroyAll();
		}
	}

	private async cleanupWorktree(threadId: string): Promise<void> {
		try {
			await this.worktreeManager.destroy(threadId, true);
		} catch {
			// Non-fatal
		}
	}

	private failResult(state: ThreadState, message: string): CompressedResult {
		return {
			success: false,
			summary: `Thread failed (attempt ${state.attempt}/${state.maxAttempts}): ${message}`,
			filesChanged: [],
			diffStats: "",
			durationMs: Date.now() - (state.startedAt || Date.now()),
			estimatedCostUsd: state.estimatedCostUsd,
		};
	}
}
