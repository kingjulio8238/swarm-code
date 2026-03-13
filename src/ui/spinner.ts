/**
 * Animated spinner with rotating verbs — inspired by Claude Code.
 *
 * Runs on an isolated 80ms animation loop separated from other output.
 * Displays a coral-colored spinner glyph + a rotating verb + optional detail.
 */

import { coral, dim, isTTY, stripAnsi, termWidth } from "./theme.js";

/** Playful verbs shown while the spinner is active. */
const VERBS = [
	"Orchestrating",
	"Decomposing",
	"Analyzing",
	"Spawning",
	"Synthesizing",
	"Weaving",
	"Parallelizing",
	"Routing",
	"Compressing",
	"Dispatching",
	"Coordinating",
	"Assembling",
	"Evaluating",
	"Distributing",
	"Reasoning",
	"Merging",
	"Refactoring",
	"Scanning",
	"Computing",
	"Resolving",
	"Strategizing",
	"Threading",
	"Optimizing",
	"Composing",
	"Investigating",
	"Constructing",
	"Iterating",
	"Transforming",
];

const SPINNER_CHARS = isTTY ? ["\u00B7", "\u2726", "\u2733", "\u2736", "\u273B", "\u273D"] : ["*"];

export class Spinner {
	private static _exitHandlerRegistered = false;
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private frameIdx = 0;
	private totalFrames = 0;
	private verbIdx = Math.floor(Math.random() * VERBS.length);
	private detail = "";
	private startTime = 0;
	private running = false;

	/** Start the spinner. */
	start(detail?: string): void {
		if (!isTTY || this.running) return;
		this.running = true;
		this.detail = detail || "";
		this.startTime = Date.now();
		this.frameIdx = 0;
		this.totalFrames = 0;
		this.verbIdx = Math.floor(Math.random() * VERBS.length);

		// Hide cursor + register exit handler to restore it
		process.stderr.write("\x1b[?25l");
		if (!Spinner._exitHandlerRegistered) {
			Spinner._exitHandlerRegistered = true;
			process.on("exit", () => {
				process.stderr.write("\x1b[?25h");
			});
		}

		const id = setInterval(() => {
			this.render();
			this.frameIdx = (this.frameIdx + 1) % SPINNER_CHARS.length;
			this.totalFrames++;
			// Rotate verb every ~2 seconds (25 frames at 80ms)
			if (this.totalFrames % 25 === 0) {
				this.verbIdx = (this.verbIdx + 1) % VERBS.length;
			}
		}, 80);
		id.unref();
		this.intervalId = id;
	}

	/** Update the detail text without restarting. */
	update(detail: string): void {
		this.detail = detail;
	}

	/** Stop the spinner and clear the line. */
	stop(): void {
		if (!this.running) return;
		this.running = false;
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
		// Clear spinner line and show cursor
		process.stderr.write("\r\x1b[K\x1b[?25h");
	}

	/** Whether the spinner is currently active. */
	get isActive(): boolean {
		return this.running;
	}

	private render(): void {
		const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
		const char = coral(SPINNER_CHARS[this.frameIdx]);
		const verb = VERBS[this.verbIdx];
		const time = dim(`${elapsed}s`);
		const detail = this.detail ? dim(` ${this.detail}`) : "";

		const line = `  ${char} ${verb}...${detail}  ${time}`;
		const maxW = termWidth();
		const stripped = stripAnsi(line);

		// Truncate if wider than terminal
		const output = stripped.length > maxW ? line.slice(0, maxW - 1) : line;
		process.stderr.write(`\r\x1b[K${output}`);
	}
}
