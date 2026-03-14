/**
 * Bordered text input for the interactive REPL.
 *
 * Visual style inspired by OpenCode — full-width bordered text area with
 * a darker background row, accent-colored bottom border, and multi-line
 * paste support.
 *
 * Keys:
 *   - Enter: submit
 *   - Escape / Ctrl+C: exit
 *   - Ctrl+D: submit
 *   - Backspace, left/right, home/end: editing
 *   - Paste (multi-char with newlines): captured as multi-line
 */

import { coral, dim, isTTY, stripAnsi, termWidth } from "./theme.js";

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const BG_DARK = "\x1b[48;2;30;33;39m"; // dark background for input row
const RESET = "\x1b[0m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const BORDER_COLOR = "\x1b[38;2;60;63;68m"; // subtle gray for top border
const ACCENT_COLOR = "\x1b[38;2;215;119;87m"; // coral for bottom border

export interface TextInputResult {
	text: string;
	action: "submit" | "escape";
}

export function readTextInput(_prompt: string): Promise<TextInputResult> {
	if (!isTTY) {
		return new Promise((resolve) => {
			let data = "";
			process.stdin.setEncoding("utf-8");
			const onData = (chunk: string) => {
				data += chunk;
				if (data.includes("\n")) {
					process.stdin.removeListener("data", onData);
					resolve({ text: data.trim(), action: "submit" });
				}
			};
			process.stdin.on("data", onData);
			process.stdin.resume();
		});
	}

	return new Promise((resolve) => {
		const linesBuf: string[] = [""];
		let cursorPos = 0;
		const origRawMode = process.stdin.isRaw;
		const w = termWidth();

		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.setEncoding("utf-8");

		// Track how many terminal rows we've drawn so we can clear them
		let drawnRows = 0;

		function drawBox() {
			const out = process.stderr;

			// Clear previously drawn rows
			if (drawnRows > 0) {
				for (let i = 0; i < drawnRows; i++) {
					out.write("\x1b[1A\x1b[2K");
				}
			}

			// Top border — thin dim line
			const topLine = `${BORDER_COLOR}${"─".repeat(w)}${RESET}`;
			out.write(`${topLine}\n`);

			// Content rows — dark background, full width
			const promptChar = `${ACCENT_COLOR}❯${RESET} `;
			const promptVisibleLen = 2; // "❯ "

			for (let i = 0; i < linesBuf.length; i++) {
				const lineText = linesBuf[i];
				const prefix = i === 0 ? promptChar : `${dim("·")} `;
				const prefixVisibleLen = promptVisibleLen;

				// How much space for text content
				const contentWidth = w - prefixVisibleLen;
				// Truncate display if line is too long
				const displayText = lineText.length > contentWidth ? lineText.slice(0, contentWidth - 1) + "…" : lineText;
				const padding = Math.max(0, contentWidth - displayText.length);

				out.write(`${BG_DARK}${prefix}${displayText}${" ".repeat(padding)}${RESET}\n`);
			}

			// Bottom border — accent colored
			const bottomLine = `${ACCENT_COLOR}${"─".repeat(w)}${RESET}`;
			out.write(`${bottomLine}\n`);

			// Hints
			out.write(`${dim("  enter submit  esc exit")}\n`);

			drawnRows = linesBuf.length + 3; // top border + content lines + bottom border + hints

			// Position cursor inside the text area
			// We're at the bottom (after hints). Move up to the correct content row.
			const currentLineIdx = linesBuf.length - 1; // cursor is always on last line
			const rowsFromBottom = 2 + (linesBuf.length - 1 - currentLineIdx); // hints + bottom border + lines below cursor
			out.write(`\x1b[${rowsFromBottom}A`);
			// Move to correct column: prefix width + cursor position
			const col = promptVisibleLen + cursorPos + 1;
			out.write(`\x1b[${col}G`);
		}

		// Initial draw
		process.stderr.write(HIDE_CURSOR);
		drawBox();
		process.stderr.write(SHOW_CURSOR);

		const onData = (data: string) => {
			const hasNewlines = data.includes("\n") || data.includes("\r");
			const isMultiChar = data.length > 1;
			const isPaste = hasNewlines && isMultiChar;

			if (isPaste) {
				const pastedLines = data.split(/\r\n|\r|\n/);
				const currentLine = linesBuf[linesBuf.length - 1];
				linesBuf[linesBuf.length - 1] = currentLine.slice(0, cursorPos) + pastedLines[0] + currentLine.slice(cursorPos);
				cursorPos = (currentLine.slice(0, cursorPos) + pastedLines[0]).length;

				for (let i = 1; i < pastedLines.length; i++) {
					const line = pastedLines[i];
					if (i === pastedLines.length - 1 && line === "") break;
					linesBuf.push(line);
					cursorPos = line.length;
				}

				// Move cursor back to top of box before redraw
				moveCursorToBoxTop();
				drawBox();
				return;
			}

			for (let i = 0; i < data.length; i++) {
				const ch = data[i];

				// Escape sequences
				if (ch === "\x1b") {
					if (data[i + 1] === "[") {
						const code = data[i + 2];
						if (code === "C" && cursorPos < linesBuf[linesBuf.length - 1].length) {
							cursorPos++;
							i += 2;
							moveCursorToBoxTop();
							drawBox();
							continue;
						}
						if (code === "D" && cursorPos > 0) {
							cursorPos--;
							i += 2;
							moveCursorToBoxTop();
							drawBox();
							continue;
						}
						if (code === "H") {
							cursorPos = 0;
							i += 2;
							moveCursorToBoxTop();
							drawBox();
							continue;
						}
						if (code === "F") {
							cursorPos = linesBuf[linesBuf.length - 1].length;
							i += 2;
							moveCursorToBoxTop();
							drawBox();
							continue;
						}
						i += 2;
						continue;
					}
					// Bare Escape — exit
					finishAndClear();
					resolve({ text: "", action: "escape" });
					return;
				}

				// Ctrl+D — submit
				if (ch === "\x04") {
					const text = linesBuf.join("\n").trim();
					finishAndClear();
					resolve({ text, action: "submit" });
					return;
				}

				// Ctrl+C — exit
				if (ch === "\x03") {
					finishAndClear();
					resolve({ text: "", action: "escape" });
					return;
				}

				// Enter — submit
				if (ch === "\r" || ch === "\n") {
					const text = linesBuf.join("\n").trim();
					finishAndClear();
					resolve({ text, action: "submit" });
					return;
				}

				// Backspace
				if (ch === "\x7f" || ch === "\b") {
					if (cursorPos > 0) {
						const line = linesBuf[linesBuf.length - 1];
						linesBuf[linesBuf.length - 1] = line.slice(0, cursorPos - 1) + line.slice(cursorPos);
						cursorPos--;
						moveCursorToBoxTop();
						drawBox();
					}
					continue;
				}

				// Tab — insert spaces
				if (ch === "\t") {
					const line = linesBuf[linesBuf.length - 1];
					linesBuf[linesBuf.length - 1] = line.slice(0, cursorPos) + "  " + line.slice(cursorPos);
					cursorPos += 2;
					moveCursorToBoxTop();
					drawBox();
					continue;
				}

				// Regular printable character
				if (ch >= " ") {
					const line = linesBuf[linesBuf.length - 1];
					linesBuf[linesBuf.length - 1] = line.slice(0, cursorPos) + ch + line.slice(cursorPos);
					cursorPos++;
					moveCursorToBoxTop();
					drawBox();
				}
			}
		};

		function moveCursorToBoxTop() {
			// From current cursor position (inside the text area), move to the line
			// before the top border so drawBox() can clear and redraw from there.
			// Current cursor is at content row (linesBuf.length - 1 from top border)
			// We need to go up past: content rows above cursor + top border
			// But drawBox handles clearing with drawnRows, so just go up to start
			const currentLineIdx = linesBuf.length - 1;
			const rowsUp = currentLineIdx + 1; // content lines above + top border
			if (rowsUp > 0) {
				process.stderr.write(`\x1b[${rowsUp}A`);
			}
			process.stderr.write("\x1b[0G");
		}

		function finishAndClear() {
			process.stdin.removeListener("data", onData);
			if (origRawMode !== undefined) {
				process.stdin.setRawMode(origRawMode);
			}

			// Move cursor to top of box and clear everything
			moveCursorToBoxTop();
			process.stderr.write("\x1b[J"); // erase to end of screen

			// Write the submitted text as a clean line (so it's visible in scrollback)
			const fullText = linesBuf.join("\n").trim();
			if (fullText) {
				const displayLines = fullText.split("\n");
				for (let i = 0; i < displayLines.length; i++) {
					const prefix = i === 0 ? `  ${coral("swarm")}${dim(">")} ` : `  ${dim(".")}       `;
					process.stderr.write(`${prefix}${displayLines[i]}\n`);
				}
			}
		}

		process.stdin.on("data", onData);
	});
}
