/**
 * Text input for the interactive REPL with multi-line paste support.
 *
 * Uses raw stdin to detect paste vs keypress:
 *   - Pasted text arrives as a single data chunk containing newlines → preserved as multi-line
 *   - Typed Enter alone → submits the input
 *   - Escape → signals exit
 *   - Ctrl+D → submits current input
 *   - Ctrl+C → signals exit
 *   - Standard editing: backspace, left/right arrows, home/end
 */

import { coral, dim, isTTY, stripAnsi } from "./theme.js";

export interface TextInputResult {
	text: string;
	action: "submit" | "escape";
}

/**
 * Read user input with multi-line paste support and escape-to-exit.
 *
 * Behavior:
 *   - Single Enter: submits current line(s)
 *   - Pasted text with newlines: captured as multi-line, then Enter submits all
 *   - Escape: returns action "escape" to signal exit
 *   - Ctrl+D: submits whatever is in the buffer
 */
export function readTextInput(prompt: string): Promise<TextInputResult> {
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
		let cursorPos = 0; // position within current (last) line
		const origRawMode = process.stdin.isRaw;

		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.setEncoding("utf-8");

		const promptVisible = stripAnsi(prompt);

		function redrawCurrentLine() {
			const currentLine = linesBuf[linesBuf.length - 1];
			process.stderr.write("\x1b[2K\x1b[0G"); // clear line
			if (linesBuf.length === 1) {
				// First line — show prompt
				process.stderr.write(`  ${prompt}${currentLine}`);
				const col = 3 + promptVisible.length + cursorPos;
				process.stderr.write(`\x1b[${col}G`);
			} else {
				// Continuation line — indent to match
				const pad = " ".repeat(promptVisible.length);
				process.stderr.write(`  ${dim(".")} ${pad.slice(2)}${currentLine}`);
				const col = 3 + promptVisible.length + cursorPos;
				process.stderr.write(`\x1b[${col}G`);
			}
		}

		// Show initial prompt
		process.stderr.write(`  ${prompt}`);

		const onData = (data: string) => {
			// Check if this looks like a paste (multiple chars with newlines)
			const hasNewlines = data.includes("\n") || data.includes("\r");
			const isMultiChar = data.length > 1;
			const isPaste = hasNewlines && isMultiChar;

			if (isPaste) {
				// Paste mode — split on newlines, add all to buffer
				const pastedLines = data.split(/\r\n|\r|\n/);
				// Append first fragment to current line at cursor
				const currentLine = linesBuf[linesBuf.length - 1];
				linesBuf[linesBuf.length - 1] = currentLine.slice(0, cursorPos) + pastedLines[0] + currentLine.slice(cursorPos);

				// Redraw current line with pasted content
				cursorPos = (currentLine.slice(0, cursorPos) + pastedLines[0]).length;
				redrawCurrentLine();

				// Add remaining lines
				for (let i = 1; i < pastedLines.length; i++) {
					const line = pastedLines[i];
					if (i === pastedLines.length - 1 && line === "") {
						// Trailing newline — don't add empty line
						break;
					}
					process.stderr.write("\n");
					linesBuf.push(line);
					cursorPos = line.length;
					redrawCurrentLine();
				}
				return;
			}

			// Character-by-character processing
			for (let i = 0; i < data.length; i++) {
				const ch = data[i];

				// Escape sequences
				if (ch === "\x1b") {
					if (data[i + 1] === "[") {
						const code = data[i + 2];
						if (code === "C") {
							// Right arrow
							if (cursorPos < linesBuf[linesBuf.length - 1].length) {
								cursorPos++;
								redrawCurrentLine();
							}
							i += 2;
							continue;
						}
						if (code === "D") {
							// Left arrow
							if (cursorPos > 0) {
								cursorPos--;
								redrawCurrentLine();
							}
							i += 2;
							continue;
						}
						if (code === "H") {
							// Home
							cursorPos = 0;
							redrawCurrentLine();
							i += 2;
							continue;
						}
						if (code === "F") {
							// End
							cursorPos = linesBuf[linesBuf.length - 1].length;
							redrawCurrentLine();
							i += 2;
							continue;
						}
						// Skip other escape sequences
						i += 2;
						continue;
					}
					// Bare Escape key — exit
					finish();
					resolve({ text: "", action: "escape" });
					return;
				}

				// Ctrl+D — submit
				if (ch === "\x04") {
					const text = linesBuf.join("\n").trim();
					finish();
					resolve({ text, action: "submit" });
					return;
				}

				// Ctrl+C — exit
				if (ch === "\x03") {
					finish();
					resolve({ text: "", action: "escape" });
					return;
				}

				// Enter — submit
				if (ch === "\r" || ch === "\n") {
					const text = linesBuf.join("\n").trim();
					finish();
					resolve({ text, action: "submit" });
					return;
				}

				// Backspace
				if (ch === "\x7f" || ch === "\b") {
					if (cursorPos > 0) {
						const line = linesBuf[linesBuf.length - 1];
						linesBuf[linesBuf.length - 1] = line.slice(0, cursorPos - 1) + line.slice(cursorPos);
						cursorPos--;
						redrawCurrentLine();
					}
					continue;
				}

				// Tab — insert spaces
				if (ch === "\t") {
					const line = linesBuf[linesBuf.length - 1];
					linesBuf[linesBuf.length - 1] = line.slice(0, cursorPos) + "  " + line.slice(cursorPos);
					cursorPos += 2;
					redrawCurrentLine();
					continue;
				}

				// Regular printable character
				if (ch >= " ") {
					const line = linesBuf[linesBuf.length - 1];
					linesBuf[linesBuf.length - 1] = line.slice(0, cursorPos) + ch + line.slice(cursorPos);
					cursorPos++;
					redrawCurrentLine();
				}
			}
		};

		function finish() {
			process.stdin.removeListener("data", onData);
			if (origRawMode !== undefined) {
				process.stdin.setRawMode(origRawMode);
			}
			process.stderr.write("\n");
		}

		process.stdin.on("data", onData);
	});
}
