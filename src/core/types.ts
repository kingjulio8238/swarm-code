/**
 * Shared type definitions for swarm-cli.
 */

// ── Agent types ─────────────────────────────────────────────────────────────

export interface AgentResult {
	success: boolean;
	output: string;
	filesChanged: string[];
	diff: string;
	durationMs: number;
	error?: string;
}

export interface AgentRunOptions {
	task: string;
	workDir: string;
	model?: string;
	files?: string[];
	signal?: AbortSignal;
	onOutput?: (chunk: string) => void;
}

export interface AgentProvider {
	readonly name: string;
	readonly isAvailable: () => Promise<boolean>;
	run(options: AgentRunOptions): Promise<AgentResult>;
}

// ── Thread types ────────────────────────────────────────────────────────────

export type ThreadStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type ThreadProgressPhase =
	| "queued"
	| "creating_worktree"
	| "agent_running"
	| "capturing_diff"
	| "compressing"
	| "completed"
	| "failed"
	| "cancelled"
	| "retrying";

export interface ThreadConfig {
	id: string;
	task: string;
	context: string;
	agent: {
		backend: string;
		model: string;
	};
	files?: string[];
}

export interface ThreadState {
	id: string;
	config: ThreadConfig;
	status: ThreadStatus;
	phase: ThreadProgressPhase;
	worktreePath?: string;
	branchName?: string;
	result?: CompressedResult;
	startedAt?: number;
	completedAt?: number;
	error?: string;
	attempt: number;
	maxAttempts: number;
	estimatedCostUsd: number;
}

export interface CompressedResult {
	success: boolean;
	summary: string;
	filesChanged: string[];
	diffStats: string;
	durationMs: number;
	estimatedCostUsd: number;
}

// ── Worktree types ──────────────────────────────────────────────────────────

export interface WorktreeInfo {
	id: string;
	path: string;
	branch: string;
}

export interface MergeResult {
	success: boolean;
	branch: string;
	conflicts: string[];
	conflictDiff: string;
	message: string;
}

// ── Budget types ────────────────────────────────────────────────────────────

export interface BudgetState {
	totalSpentUsd: number;
	threadCosts: Map<string, number>;
	sessionLimitUsd: number;
	perThreadLimitUsd: number;
}

/** Rough per-1M-token pricing for cost estimation. */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
	// Anthropic
	"claude-sonnet-4-6": { input: 3, output: 15 },
	"claude-opus-4-6": { input: 15, output: 75 },
	"claude-haiku-4-5": { input: 0.8, output: 4 },
	// OpenAI
	"gpt-4o": { input: 2.5, output: 10 },
	"gpt-4o-mini": { input: 0.15, output: 0.6 },
	"o3": { input: 10, output: 40 },
	"o3-mini": { input: 1.1, output: 4.4 },
	// Google
	"gemini-2.5-pro": { input: 1.25, output: 10 },
	"gemini-2.5-flash": { input: 0.15, output: 0.6 },
};

// ── Config types ────────────────────────────────────────────────────────────

export interface SwarmConfig {
	// Inherited from RLM
	max_iterations: number;
	max_depth: number;
	max_sub_queries: number;
	truncate_len: number;
	metadata_preview_lines: number;

	// Swarm extensions
	max_threads: number;
	max_total_threads: number;
	thread_timeout_ms: number;
	max_thread_budget_usd: number;
	max_session_budget_usd: number;
	default_agent: string;
	default_model: string;
	auto_model_selection: boolean;
	compression_strategy: "structured" | "llm-summary" | "diff-only" | "truncate";
	compression_max_tokens: number;
	worktree_base_dir: string;
	auto_cleanup_worktrees: boolean;
	episodic_memory_enabled: boolean;
	memory_dir: string;
	thread_retries: number;
}

// ── Protocol messages (Python <-> TS) ───────────────────────────────────────

export interface ThreadRequestMessage {
	type: "thread_request";
	id: string;
	task: string;
	context: string;
	agent_backend: string;
	model: string;
	files: string[];
}

export interface ThreadResultMessage {
	type: "thread_result";
	id: string;
	result: string;
	success: boolean;
	files_changed: string[];
	duration_ms: number;
}

export interface MergeRequestMessage {
	type: "merge_request";
	id: string;
}

export interface MergeResultMessage {
	type: "merge_result";
	id: string;
	result: string;
	success: boolean;
}
