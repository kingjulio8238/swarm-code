#!/usr/bin/env tsx
/**
 * swarm — Swarm-native coding agent orchestrator
 *
 * Entry point for the `swarm` command.
 *
 *   swarm                  → interactive terminal (RLM mode, default)
 *   swarm run              → single-shot RLM CLI run
 *   swarm viewer           → browse trajectory files
 *   swarm benchmark        → run benchmarks
 *   swarm --dir ./project  → swarm mode (coding agent orchestration)
 */

const HELP = `
\x1b[36m╔══════════════════════════════════════════════════════════════╗
║          swarm — Swarm-Native Coding Agent                 ║
║     Open-source orchestrator for parallel coding agents     ║
║              Built on RLM (arXiv:2512.24601)               ║
╚══════════════════════════════════════════════════════════════╝\x1b[0m

\x1b[1mSWARM MODE\x1b[0m (coding agent orchestration)
  \x1b[33mswarm\x1b[0m --dir ./project "add error handling to all API routes"
  \x1b[33mswarm\x1b[0m --dir ./project --orchestrator claude-sonnet-4-6 "task"
  \x1b[33mswarm\x1b[0m --dir ./project --dry-run "plan refactor"
  \x1b[33mswarm\x1b[0m --dir ./project --max-budget 5.00 "task"

\x1b[1mRLM MODE\x1b[0m (text processing, inherited from rlm-cli)
  \x1b[33mswarm\x1b[0m                          Interactive terminal (default)
  \x1b[33mswarm run\x1b[0m [options] "<query>"  Run a single query
  \x1b[33mswarm viewer\x1b[0m                    Browse saved trajectory files
  \x1b[33mswarm benchmark\x1b[0m <name> [--idx]  Run benchmark

\x1b[1mSWARM OPTIONS\x1b[0m
  --dir <path>           Target repository directory
  --orchestrator <model> Model for the orchestrator LLM (default: RLM_MODEL)
  --agent <backend>      Default agent backend (default: opencode)
  --dry-run              Plan only, don't spawn threads
  --max-budget <usd>     Maximum session budget in USD
  --verbose              Show detailed progress

\x1b[1mRUN OPTIONS\x1b[0m
  --model <id>     Override model (default: RLM_MODEL from .env)
  --file <path>    Read context from a file
  --url <url>      Fetch context from a URL
  --stdin          Read context from stdin

\x1b[1mCONFIGURATION\x1b[0m
  .env file (pick one provider):
    ANTHROPIC_API_KEY=sk-ant-...
    OPENAI_API_KEY=sk-...
    GEMINI_API_KEY=AIza...

  swarm_config.yaml:
    max_threads: 5
    default_agent: opencode
    compression_strategy: structured
`.trim();

async function main() {
	const args = process.argv.slice(2);

	// Check if this is swarm mode (has --dir flag)
	const dirIdx = args.indexOf("--dir");
	if (dirIdx !== -1) {
		// Swarm mode — dynamic import to avoid loading all swarm deps upfront
		const { runSwarmMode } = await import("./swarm.js");
		await runSwarmMode(args);
		return;
	}

	const command = args[0] || "interactive";

	switch (command) {
		case "interactive":
		case "i": {
			await import("./interactive.js");
			break;
		}

		case "viewer":
		case "view": {
			process.argv = [process.argv[0], process.argv[1], ...args.slice(1)];
			await import("./viewer.js");
			break;
		}

		case "run": {
			process.argv = [process.argv[0], process.argv[1], ...args.slice(1)];
			await import("./cli.js");
			break;
		}

		case "benchmark":
		case "bench": {
			const benchName = args[1];
			const benchArgs = args.slice(2);

			const benchScripts: Record<string, string> = {
				oolong: "benchmarks/oolong_synth.ts",
				longbench: "benchmarks/longbench_narrativeqa.ts",
			};

			if (benchName && benchScripts[benchName]) {
				const { spawn } = await import("node:child_process");
				const { dirname, join } = await import("node:path");
				const { fileURLToPath } = await import("node:url");
				const root = join(dirname(fileURLToPath(import.meta.url)), "..");
				const script = join(root, benchScripts[benchName]);
				const tsxBin = join(root, "node_modules", ".bin", "tsx");

				await new Promise<void>((resolve, reject) => {
					const child = spawn(tsxBin, [script, ...benchArgs], {
						stdio: "inherit",
						cwd: root,
					});
					child.on("exit", (code) => {
						process.exitCode = code ?? 1;
						resolve();
					});
					child.on("error", (err) => {
						reject(new Error(`Failed to spawn benchmark: ${err.message}`));
					});
				});
			} else {
				console.log(`\x1b[36m\x1b[1mswarm benchmark\x1b[0m — Run direct LLM vs RLM comparison\n`);
				console.log(`\x1b[1mUSAGE\x1b[0m`);
				console.log(`  \x1b[33mswarm benchmark oolong\x1b[0m    [--idx N]  Oolong Synth`);
				console.log(`  \x1b[33mswarm benchmark longbench\x1b[0m [--idx N]  LongBench NarrativeQA\n`);
			}
			break;
		}

		case "help":
		case "--help":
		case "-h": {
			console.log(HELP);
			break;
		}

		case "version":
		case "--version":
		case "-v": {
			try {
				const { readFileSync } = await import("node:fs");
				const { dirname, join } = await import("node:path");
				const { fileURLToPath } = await import("node:url");
				const __dir = dirname(fileURLToPath(import.meta.url));
				const pkgPath = join(__dir, "..", "package.json");
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
				console.log(`swarm v${pkg.version}`);
			} catch {
				console.log("swarm (version unknown)");
			}
			break;
		}

		default: {
			if (command.startsWith("--")) {
				// Flags without subcommand — check for --dir (swarm mode)
				if (command === "--dir") {
					const { runSwarmMode } = await import("./swarm.js");
					await runSwarmMode(args);
				} else {
					// Assume "run" mode, pass all args through
					process.argv = [process.argv[0], process.argv[1], ...args];
					await import("./cli.js");
				}
			} else {
				console.error(`Unknown command: ${command}`);
				console.error('Run "swarm help" for usage information.');
				process.exit(1);
			}
		}
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
