/**
 * Direct LLM agent backend.
 *
 * Preserves the original llm_query behavior — sends a prompt directly to an LLM
 * without any coding agent wrapper. Useful for lightweight analysis tasks.
 */

import type { AgentProvider, AgentResult, AgentRunOptions } from "../core/types.js";
import { registerAgent } from "./provider.js";

const directLlmProvider: AgentProvider = {
	name: "direct-llm",

	async isAvailable(): Promise<boolean> {
		// Available if any LLM API key is set
		return !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY);
	},

	async run(options: AgentRunOptions): Promise<AgentResult> {
		const startTime = Date.now();

		try {
			// Import pi-ai dynamically to avoid loading it at module level
			const { completeSimple, getModels, getProviders } = await import("@mariozechner/pi-ai");
			const modelId = options.model || process.env.RLM_MODEL || "claude-sonnet-4-6";

			// Find model
			let model;
			for (const provider of getProviders()) {
				for (const m of getModels(provider)) {
					if (m.id === modelId) {
						model = m;
						break;
					}
				}
				if (model) break;
			}

			if (!model) {
				return {
					success: false,
					output: "",
					filesChanged: [],
					diff: "",
					durationMs: Date.now() - startTime,
					error: `Model "${modelId}" not found`,
				};
			}

			const response = await completeSimple(model, {
				systemPrompt: "You are a helpful assistant. Be concise and thorough.",
				messages: [
					{
						role: "user" as const,
						content: options.task,
						timestamp: Date.now(),
					},
				],
			});

			const output = response.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join("\n");

			return {
				success: true,
				output,
				filesChanged: [],
				diff: "",
				durationMs: Date.now() - startTime,
			};
		} catch (err) {
			return {
				success: false,
				output: "",
				filesChanged: [],
				diff: "",
				durationMs: Date.now() - startTime,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	},
};

registerAgent(directLlmProvider);
export default directLlmProvider;
