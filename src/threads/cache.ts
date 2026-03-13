/**
 * Thread cache — caches thread results by (task, files, agent) hash.
 *
 * Slate's "subthread reuse" optimization: when the orchestrator spawns
 * an identical thread (same task + same files + same agent), return the
 * cached result instead of re-running the agent. Saves cost and time.
 *
 * Cache is session-scoped (in-memory) by default.
 * Cache keys are SHA-256 hashes of normalized (task, files, agent, model).
 */

import { createHash } from "node:crypto";
import type { CompressedResult } from "../core/types.js";

export interface ThreadCacheEntry {
	result: CompressedResult;
	cachedAt: number;
	hitCount: number;
}

export interface ThreadCacheStats {
	size: number;
	hits: number;
	misses: number;
	totalSavedMs: number;
	totalSavedUsd: number;
}

/**
 * Compute a stable cache key from thread parameters.
 * Normalizes inputs: trims task, sorts files, lowercases agent/model.
 */
function computeCacheKey(
	task: string,
	files: string[],
	agent: string,
	model: string,
): string {
	const normalized = JSON.stringify({
		task: task.trim(),
		files: [...files].sort(),
		agent: agent.toLowerCase(),
		model: model.toLowerCase(),
	});
	return createHash("sha256").update(normalized).digest("hex");
}

export class ThreadCache {
	private cache: Map<string, ThreadCacheEntry> = new Map();
	private hits: number = 0;
	private misses: number = 0;
	private totalSavedMs: number = 0;
	private totalSavedUsd: number = 0;
	private maxEntries: number;

	constructor(maxEntries: number = 100) {
		this.maxEntries = maxEntries;
	}

	/**
	 * Look up a cached result for the given thread parameters.
	 * Returns undefined on cache miss.
	 */
	get(
		task: string,
		files: string[],
		agent: string,
		model: string,
	): CompressedResult | undefined {
		const key = computeCacheKey(task, files, agent, model);
		const entry = this.cache.get(key);

		if (!entry) {
			this.misses++;
			return undefined;
		}

		// Only return successful cached results
		if (!entry.result.success) {
			this.misses++;
			return undefined;
		}

		this.hits++;
		entry.hitCount++;
		this.totalSavedMs += entry.result.durationMs;
		this.totalSavedUsd += entry.result.estimatedCostUsd;

		return entry.result;
	}

	/**
	 * Store a thread result in the cache.
	 * Only caches successful results — failed threads should be retried.
	 */
	set(
		task: string,
		files: string[],
		agent: string,
		model: string,
		result: CompressedResult,
	): void {
		// Don't cache failures
		if (!result.success) return;

		// Evict oldest entry if at capacity
		if (this.cache.size >= this.maxEntries) {
			const oldestKey = this.cache.keys().next().value;
			if (oldestKey !== undefined) {
				this.cache.delete(oldestKey);
			}
		}

		const key = computeCacheKey(task, files, agent, model);
		this.cache.set(key, {
			result,
			cachedAt: Date.now(),
			hitCount: 0,
		});
	}

	/** Get cache statistics. */
	getStats(): ThreadCacheStats {
		return {
			size: this.cache.size,
			hits: this.hits,
			misses: this.misses,
			totalSavedMs: this.totalSavedMs,
			totalSavedUsd: this.totalSavedUsd,
		};
	}

	/** Clear all cached entries. */
	clear(): void {
		this.cache.clear();
	}
}
