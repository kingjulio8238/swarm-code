/**
 * Context compression — compresses thread output before returning to the orchestrator.
 *
 * Strategies:
 *   - structured (default): status + files + diff stats + key hunks + tail output
 *   - diff-only: just the git diff
 *   - truncate: raw truncation
 *   - llm-summary: use a cheap LLM to summarize thread work
 */

import type { SwarmConfig } from "../core/types.js";

export interface CompressionInput {
	agentOutput: string;
	diff: string;
	diffStats: string;
	filesChanged: string[];
	success: boolean;
	durationMs: number;
	error?: string;
}

/** Optional LLM summarizer for llm-summary strategy. */
export type LlmSummarizer = (text: string, instruction: string) => Promise<string>;

// Module-level summarizer — set once by the swarm orchestrator
let _summarizer: LlmSummarizer | undefined;

/** Register an LLM summarizer for the llm-summary compression strategy. */
export function setSummarizer(fn: LlmSummarizer): void {
	_summarizer = fn;
}

export async function compressResult(
	input: CompressionInput,
	strategy: SwarmConfig["compression_strategy"] = "structured",
	maxChars: number = 1000,
): Promise<string> {
	switch (strategy) {
		case "structured":
			return compressStructured(input, maxChars);
		case "diff-only":
			return compressDiffOnly(input, maxChars);
		case "truncate":
			return compressTruncate(input, maxChars);
		case "llm-summary":
			return compressLlmSummary(input, maxChars);
		default:
			return compressStructured(input, maxChars);
	}
}

function compressStructured(input: CompressionInput, maxChars: number): string {
	const parts: string[] = [];

	// Status line
	parts.push(`Status: ${input.success ? "SUCCESS" : "FAILED"} (${(input.durationMs / 1000).toFixed(1)}s)`);

	if (input.error) {
		parts.push(`Error: ${input.error}`);
	}

	// Files changed
	if (input.filesChanged.length > 0) {
		parts.push(`Files changed (${input.filesChanged.length}):`);
		for (const f of input.filesChanged.slice(0, 20)) {
			parts.push(`  - ${f}`);
		}
		if (input.filesChanged.length > 20) {
			parts.push(`  ... and ${input.filesChanged.length - 20} more`);
		}
	}

	// Diff stats
	if (input.diffStats && input.diffStats !== "(no changes)") {
		parts.push(`\nDiff stats:\n${input.diffStats}`);
	}

	// Key diff hunks (first portion)
	if (input.diff && input.diff !== "(no changes)") {
		const diffBudget = Math.floor(maxChars * 0.4);
		const truncatedDiff = input.diff.length > diffBudget
			? input.diff.slice(0, diffBudget) + "\n... [diff truncated]"
			: input.diff;
		parts.push(`\nKey changes:\n${truncatedDiff}`);
	}

	// Agent output tail
	if (input.agentOutput) {
		const outputBudget = Math.floor(maxChars * 0.3);
		const lines = input.agentOutput.split("\n");
		const tail = lines.slice(-30).join("\n");
		const truncatedOutput = tail.length > outputBudget
			? tail.slice(-outputBudget)
			: tail;
		parts.push(`\nAgent output (last 30 lines):\n${truncatedOutput}`);
	}

	const result = parts.join("\n");

	// Final truncation safety (4x maxChars is the hard cap for combined sections)
	if (result.length > maxChars * 4) {
		return result.slice(0, maxChars * 4) + "\n... [compressed output truncated]";
	}

	return result;
}

function compressDiffOnly(input: CompressionInput, maxChars: number): string {
	const status = `Status: ${input.success ? "SUCCESS" : "FAILED"} (${(input.durationMs / 1000).toFixed(1)}s)`;

	if (!input.diff || input.diff === "(no changes)") {
		return `${status}\n(no changes)`;
	}

	if (input.diff.length > maxChars * 4) {
		return `${status}\n${input.diff.slice(0, maxChars * 4)}\n... [diff truncated]`;
	}

	return `${status}\n${input.diff}`;
}

function compressTruncate(input: CompressionInput, maxChars: number): string {
	const raw = [
		`Status: ${input.success ? "SUCCESS" : "FAILED"}`,
		input.agentOutput,
		input.diff,
	].filter(Boolean).join("\n\n");

	if (raw.length > maxChars * 4) {
		return raw.slice(-(maxChars * 4));
	}
	return raw;
}

/**
 * LLM-based compression — uses a cheap model to summarize the thread's work.
 * Falls back to structured compression if no summarizer is registered.
 */
async function compressLlmSummary(input: CompressionInput, maxChars: number): Promise<string> {
	if (!_summarizer) {
		// Fall back to structured if no summarizer available
		return compressStructured(input, maxChars);
	}

	// Build the text to summarize
	const parts: string[] = [];
	parts.push(`Task outcome: ${input.success ? "SUCCESS" : "FAILED"} (${(input.durationMs / 1000).toFixed(1)}s)`);

	if (input.error) {
		parts.push(`Error: ${input.error}`);
	}

	if (input.filesChanged.length > 0) {
		parts.push(`Files changed: ${input.filesChanged.join(", ")}`);
	}

	if (input.diffStats && input.diffStats !== "(no changes)") {
		parts.push(`Diff stats:\n${input.diffStats}`);
	}

	// Include truncated diff for context
	if (input.diff && input.diff !== "(no changes)") {
		const diffSlice = input.diff.slice(0, maxChars * 2);
		parts.push(`Diff:\n${diffSlice}`);
	}

	// Include truncated agent output
	if (input.agentOutput) {
		const outputSlice = input.agentOutput.slice(-maxChars);
		parts.push(`Agent output (tail):\n${outputSlice}`);
	}

	const textToSummarize = parts.join("\n\n");

	const instruction = [
		"Summarize this coding agent thread result concisely.",
		"Include: what was done, which files were changed, whether it succeeded, and any key details.",
		`Keep the summary under ${maxChars} characters.`,
		"Be specific about code changes — mention function names, patterns, and key decisions.",
	].join(" ");

	try {
		const summary = await _summarizer(textToSummarize, instruction);

		// Prepend status line
		const status = `Status: ${input.success ? "SUCCESS" : "FAILED"} (${(input.durationMs / 1000).toFixed(1)}s)`;
		const filesLine = input.filesChanged.length > 0
			? `\nFiles: ${input.filesChanged.join(", ")}`
			: "";
		const result = `${status}${filesLine}\n\n${summary}`;

		// Safety cap
		if (result.length > maxChars * 2) {
			return result.slice(0, maxChars * 2) + "\n... [summary truncated]";
		}
		return result;
	} catch {
		// Fall back to structured on LLM failure
		return compressStructured(input, maxChars);
	}
}
