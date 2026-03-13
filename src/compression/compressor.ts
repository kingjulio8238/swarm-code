/**
 * Context compression — compresses thread output before returning to the orchestrator.
 *
 * Strategies:
 *   - structured (default): status + files + diff stats + key hunks + tail output
 *   - diff-only: just the git diff
 *   - truncate: raw truncation
 *   - llm-summary: use a cheap model to summarize (Phase 3)
 */

import type { AgentResult, SwarmConfig } from "../core/types.js";

export interface CompressionInput {
	agentOutput: string;
	diff: string;
	diffStats: string;
	filesChanged: string[];
	success: boolean;
	durationMs: number;
	error?: string;
}

export function compressResult(
	input: CompressionInput,
	strategy: SwarmConfig["compression_strategy"] = "structured",
	maxTokens: number = 1000,
): string {
	switch (strategy) {
		case "structured":
			return compressStructured(input, maxTokens);
		case "diff-only":
			return compressDiffOnly(input, maxTokens);
		case "truncate":
			return compressTruncate(input, maxTokens);
		case "llm-summary":
			// Falls back to structured until Phase 3
			return compressStructured(input, maxTokens);
		default:
			return compressStructured(input, maxTokens);
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

	// Final truncation safety
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
