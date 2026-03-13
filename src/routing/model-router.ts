/**
 * Model router — auto-selects the best agent + model combination per task.
 *
 * Inspired by Slate's approach: the orchestrator LLM naturally selects agents
 * and models based on task complexity. This module provides a fallback
 * rule-based router for when auto_model_selection is enabled, ensuring
 * cost-efficient defaults even when the orchestrator doesn't explicitly choose.
 *
 * Two routing dimensions:
 *   1. Task complexity (simple/medium/complex) → picks model tier
 *   2. Task slot (execution/search/reasoning/planning) → picks agent + model specialty
 *
 * Two routing modes:
 *   1. Orchestrator-driven (default): The orchestrator prompt teaches the LLM
 *      about agent strengths, and the LLM passes agent/model in thread() calls.
 *   2. Auto-routing (auto_model_selection=true): This router overrides the
 *      orchestrator's choice with a cost-optimal selection based on task analysis.
 */

import type { SwarmConfig } from "../core/types.js";
import type { ModelSlots } from "../config.js";
import { getAvailableAgents } from "../agents/provider.js";

// ── Agent capabilities ─────────────────────────────────────────────────────

export interface AgentCapability {
	name: string;
	/** Cost tier: 1 = cheapest, 5 = most expensive */
	costTier: number;
	/** Speed tier: 1 = fastest, 5 = slowest */
	speedTier: number;
	/** What this agent excels at */
	strengths: string[];
	/** Best model for this agent (provider/model-id format) */
	defaultModel: string;
	/** Cheaper model for simple tasks */
	cheapModel: string;
	/** Premium model for complex tasks */
	premiumModel: string;
}

export const AGENT_CAPABILITIES: Record<string, AgentCapability> = {
	"opencode": {
		name: "opencode",
		costTier: 2,
		speedTier: 2,
		strengths: ["general-purpose", "multi-language", "fast", "tool-use", "testing"],
		defaultModel: "anthropic/claude-sonnet-4-6",
		cheapModel: "anthropic/claude-haiku-4-5",
		premiumModel: "anthropic/claude-opus-4-6",
	},
	"claude-code": {
		name: "claude-code",
		costTier: 3,
		speedTier: 3,
		strengths: ["deep-analysis", "refactoring", "architecture", "complex-reasoning", "large-codebase"],
		defaultModel: "claude-sonnet-4-6",
		cheapModel: "claude-haiku-4-5",
		premiumModel: "claude-opus-4-6",
	},
	"codex": {
		name: "codex",
		costTier: 2,
		speedTier: 2,
		strengths: ["code-execution", "shell-commands", "testing", "openai-models", "tool-use"],
		defaultModel: "o3-mini",
		cheapModel: "gpt-4o-mini",
		premiumModel: "o3",
	},
	"aider": {
		name: "aider",
		costTier: 1,
		speedTier: 1,
		strengths: ["targeted-edits", "minimal-changes", "git-aware", "cost-efficient", "linting", "formatting"],
		defaultModel: "anthropic/claude-sonnet-4-6",
		cheapModel: "anthropic/claude-haiku-4-5",
		premiumModel: "anthropic/claude-opus-4-6",
	},
	"direct-llm": {
		name: "direct-llm",
		costTier: 1,
		speedTier: 1,
		strengths: ["analysis", "planning", "no-file-changes", "classification", "lightweight"],
		defaultModel: "anthropic/claude-sonnet-4-6",
		cheapModel: "anthropic/claude-haiku-4-5",
		premiumModel: "anthropic/claude-opus-4-6",
	},
};

// ── Task complexity classification ─────────────────────────────────────────

export type TaskComplexity = "simple" | "medium" | "complex";

/** Simple keyword-based complexity classifier. */
export function classifyTaskComplexity(task: string): TaskComplexity {
	const lower = task.toLowerCase();

	// Complex indicators
	const complexPatterns = [
		"refactor", "architect", "redesign", "migrate",
		"rewrite", "overhaul", "restructure",
		"security audit", "performance optim",
		"complex", "multiple files", "across the codebase",
		"entire", "all files", "comprehensive",
	];
	if (complexPatterns.some(p => lower.includes(p))) return "complex";

	// Simple indicators
	const simplePatterns = [
		"add comment", "fix typo", "rename", "format",
		"lint", "add import", "remove unused",
		"update version", "bump", "simple",
		"add docstring", "fix indent", "whitespace",
	];
	if (simplePatterns.some(p => lower.includes(p))) return "simple";

	// Default to medium
	return "medium";
}

// ── Named model slots ─────────────────────────────────────────────────────

/**
 * Task slots — named categories that map to specialized model/agent combos.
 * Inspired by Slate's model slots (main, subagent, search, reasoning).
 */
export type TaskSlot = "execution" | "search" | "reasoning" | "planning";

export const DEFAULT_MODEL_SLOTS: ModelSlots = {
	execution: "",  // empty = use agent's default based on complexity
	search: "",
	reasoning: "",
	planning: "",
};

/** Preferred agent per slot when auto-routing. */
const SLOT_AGENT_PREFERENCES: Record<TaskSlot, string[]> = {
	execution: ["opencode", "codex", "claude-code", "aider"],
	search: ["direct-llm", "opencode", "codex"],
	reasoning: ["claude-code", "direct-llm", "opencode"],
	planning: ["direct-llm", "claude-code"],
};

/** Classify a task into a named slot based on keyword analysis. */
export function classifyTaskSlot(task: string): TaskSlot {
	const lower = task.toLowerCase();

	// Search patterns — retrieving information, finding things
	const searchPatterns = [
		"search", "find", "look up", "locate", "grep",
		"what is", "where is", "which file", "list all",
		"documentation", "docs", "research", "investigate",
	];
	if (searchPatterns.some(p => lower.includes(p))) return "search";

	// Reasoning patterns — analysis, review, understanding
	const reasoningPatterns = [
		"analyze", "analysis", "review", "explain", "understand",
		"why does", "how does", "debug", "diagnose", "trace",
		"reason", "evaluate", "assess", "compare",
	];
	if (reasoningPatterns.some(p => lower.includes(p))) return "reasoning";

	// Planning patterns — design, architecture, strategy
	const planningPatterns = [
		"plan", "design", "architect", "propose", "strategy",
		"roadmap", "outline", "spec", "specification", "rfc",
		"how should", "what approach", "break down",
	];
	if (planningPatterns.some(p => lower.includes(p))) return "planning";

	// Default: execution (coding, fixing, building)
	return "execution";
}

// ── Router ─────────────────────────────────────────────────────────────────

export interface RouteResult {
	agent: string;
	model: string;
	slot: TaskSlot;
	reason: string;
}

/**
 * Route a task to the best agent + model combination.
 *
 * Logic:
 *   1. Classify task complexity (simple/medium/complex)
 *   2. Classify task slot (execution/search/reasoning/planning)
 *   3. Check for slot-specific model overrides in config
 *   4. Score agents with slot preference bonus
 *   5. Pick the cheapest capable option
 */
export async function routeTask(
	task: string,
	config: SwarmConfig,
): Promise<RouteResult> {
	const complexity = classifyTaskComplexity(task);
	const slot = classifyTaskSlot(task);
	const available = await getAvailableAgents();
	const lower = task.toLowerCase();

	// Check for slot-specific model override from config
	const slotOverrides = config.model_slots || DEFAULT_MODEL_SLOTS;
	const slotModel = slotOverrides[slot];

	// If no agents available, fall back to direct-llm
	if (available.length === 0) {
		return {
			agent: "direct-llm",
			model: slotModel || config.default_model,
			slot,
			reason: "no agent backends available, falling back to direct LLM",
		};
	}

	// Get preferred agents for this slot
	const slotPrefs = SLOT_AGENT_PREFERENCES[slot];

	// Score each available agent for this task
	const scored = available
		.map(name => {
			const cap = AGENT_CAPABILITIES[name];
			if (!cap) return { name, score: 0, model: config.default_model };

			let score = 0;

			// Strength matching
			for (const strength of cap.strengths) {
				const keywords = strength.split("-");
				for (const kw of keywords) {
					if (lower.includes(kw) && kw.length > 3) score += 2;
				}
			}

			// Slot preference bonus — agents preferred for this slot get a boost
			const slotRank = slotPrefs.indexOf(name);
			if (slotRank !== -1) {
				score += (slotPrefs.length - slotRank) * 2;
			}

			// Complexity-cost alignment
			if (complexity === "simple") {
				// Prefer cheap + fast agents
				score += (5 - cap.costTier) + (5 - cap.speedTier);
			} else if (complexity === "medium") {
				// Balanced — moderate cost/capability, favor speed
				score += 3 - Math.abs(cap.costTier - 2) + (4 - cap.speedTier);
			} else if (complexity === "complex") {
				// Prefer capable agents, cost is less important
				score += cap.costTier; // Higher cost often = more capable
			}

			// Select model: slot override > complexity-based default
			let model: string;
			if (slotModel) {
				model = slotModel;
			} else {
				switch (complexity) {
					case "simple": model = cap.cheapModel; break;
					case "complex": model = cap.premiumModel; break;
					default: model = cap.defaultModel; break;
				}
			}

			return { name, score, model };
		})
		.sort((a, b) => b.score - a.score);

	const best = scored[0];

	return {
		agent: best.name,
		model: best.model,
		slot,
		reason: `${slot}/${complexity} → ${best.name} (score: ${best.score})`,
	};
}

/**
 * Get a description of available agents and their capabilities
 * for inclusion in the orchestrator prompt.
 */
export async function describeAvailableAgents(): Promise<string> {
	const available = await getAvailableAgents();
	if (available.length === 0) return "No agent backends available.";

	const lines: string[] = [];
	for (const name of available) {
		const cap = AGENT_CAPABILITIES[name];
		if (!cap) {
			lines.push(`- **${name}**: Available (no capability metadata)`);
			continue;
		}
		const cost = ["$", "$$", "$$$", "$$$$", "$$$$$"][cap.costTier - 1];
		const speed = ["fast", "fast", "medium", "slow", "very slow"][cap.speedTier - 1];
		lines.push(
			`- **${name}** (${cost}, ${speed}): ${cap.strengths.join(", ")}` +
			`\n  Default model: \`${cap.defaultModel}\` | Cheap: \`${cap.cheapModel}\` | Premium: \`${cap.premiumModel}\``
		);
	}

	// Add slot routing info
	lines.push("");
	lines.push("**Model slots** (auto-routing selects the best agent per task type):");
	lines.push("- `execution` — coding, fixing, building → prefers opencode, codex");
	lines.push("- `search` — finding files, researching docs → prefers direct-llm");
	lines.push("- `reasoning` — analysis, debugging, review → prefers claude-code, direct-llm");
	lines.push("- `planning` — design, architecture, strategy → prefers direct-llm, claude-code");

	return lines.join("\n");
}
