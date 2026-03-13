/**
 * Live thread status dashboard — shows running/queued/completed threads.
 *
 * Inspired by Claude Code's collapsed tool results: shows concise status
 * per thread, color-coded by phase, with elapsed time and file counts.
 * Uses in-place terminal updates for a live-updating display.
 */

import { getLogLevel, isJsonMode } from "./log.js";
import { coral, cyan, dim, green, isTTY, red, stripAnsi, symbols, termWidth, truncate, yellow } from "./theme.js";

interface ThreadStatus {
	id: string;
	task: string;
	phase: string;
	agent: string;
	model: string;
	startedAt: number;
	filesChanged?: number;
	detail?: string;
}

/**
 * Thread dashboard — manages a live-updating display of thread states.
 * Renders below the spinner line using ANSI cursor movement.
 */
export class ThreadDashboard {
	private threads: Map<string, ThreadStatus> = new Map();
	private pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set();
	private lastLineCount = 0;
	private enabled: boolean;

	constructor() {
		this.enabled = isTTY && !isJsonMode() && getLogLevel() !== "quiet";
	}

	/** Update a thread's status. */
	update(
		id: string,
		phase: string,
		detail?: string,
		extra?: {
			task?: string;
			agent?: string;
			model?: string;
			filesChanged?: number;
		},
	): void {
		const existing = this.threads.get(id);
		if (existing) {
			existing.phase = phase;
			if (detail) existing.detail = detail;
			if (extra?.filesChanged !== undefined) existing.filesChanged = extra.filesChanged;
		} else {
			this.threads.set(id, {
				id,
				task: extra?.task || "",
				phase,
				agent: extra?.agent || "",
				model: extra?.model || "",
				startedAt: Date.now(),
				filesChanged: extra?.filesChanged,
				detail,
			});
		}
		this.render();
	}

	/** Remove a thread from the dashboard (when done). */
	complete(id: string, phase: string, detail?: string): void {
		const existing = this.threads.get(id);
		if (existing) {
			existing.phase = phase;
			if (detail) existing.detail = detail;
		}
		this.render();

		// Remove completed/failed threads after a brief display
		const timer = setTimeout(() => {
			this.pendingTimers.delete(timer);
			this.threads.delete(id);
			this.render();
		}, 1500);
		this.pendingTimers.add(timer);
	}

	/** Clear all dashboard output and cancel pending timers. */
	clear(): void {
		for (const timer of this.pendingTimers) clearTimeout(timer);
		this.pendingTimers.clear();
		if (!this.enabled) return;
		this.clearLines();
		this.threads.clear();
		this.lastLineCount = 0;
	}

	private render(): void {
		if (!this.enabled) return;

		// Clear previous output
		this.clearLines();

		const lines = this.buildLines();
		if (lines.length === 0) {
			this.lastLineCount = 0;
			return;
		}

		// Write new lines
		process.stderr.write(`${lines.join("\n")}\n`);
		this.lastLineCount = lines.length;
	}

	private clearLines(): void {
		if (this.lastLineCount <= 0) return;
		// Move up and clear each line
		for (let i = 0; i < this.lastLineCount; i++) {
			process.stderr.write("\x1b[1A\x1b[K");
		}
	}

	private buildLines(): string[] {
		const w = Math.min(termWidth(), 80);
		const lines: string[] = [];
		const now = Date.now();

		for (const [, t] of this.threads) {
			const elapsed = ((now - t.startedAt) / 1000).toFixed(1);
			const tag = dim(t.id.slice(0, 8));
			const phase = this.formatPhase(t.phase);
			const time = dim(`${elapsed}s`);
			const task = t.task ? truncate(t.task, 40) : "";
			const detail = t.detail ? dim(t.detail) : "";

			let line: string;
			if (t.phase === "completed") {
				const files = t.filesChanged !== undefined ? dim(`${t.filesChanged} files`) : "";
				line = `    ${tag}  ${phase}  ${time}  ${files}  ${detail}`;
			} else if (t.phase === "failed" || t.phase === "cancelled") {
				line = `    ${tag}  ${phase}  ${time}  ${detail}`;
			} else {
				line = `    ${tag}  ${phase}  ${time}  ${dim(task)}`;
			}

			// Truncate to terminal width
			if (stripAnsi(line).length > w) {
				line = line.slice(0, w + (line.length - stripAnsi(line).length) - 1);
			}
			lines.push(line);
		}

		return lines;
	}

	private formatPhase(phase: string): string {
		switch (phase) {
			case "queued":
				return dim("queued");
			case "creating_worktree":
				return cyan("creating worktree");
			case "agent_running":
				return coral("running agent");
			case "capturing_diff":
				return cyan("capturing diff");
			case "compressing":
				return dim("compressing");
			case "completed":
				return green(`${symbols.check} completed`);
			case "failed":
				return red(`${symbols.cross} failed`);
			case "cancelled":
				return yellow("cancelled");
			case "retrying":
				return yellow("retrying");
			default:
				return dim(phase);
		}
	}
}
