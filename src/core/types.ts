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
	worktreePath?: string;
	branchName?: string;
	result?: CompressedResult;
	startedAt?: number;
	completedAt?: number;
	error?: string;
}

export interface CompressedResult {
	success: boolean;
	summary: string;
	filesChanged: string[];
	diffStats: string;
	durationMs: number;
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
	message: string;
}

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
