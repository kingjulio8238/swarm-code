# swarm-cli

Open-source swarm-native coding agent orchestrator. Fork of rlm-cli extended with parallel coding agent threads in isolated git worktrees.

## Quick Start

```bash
# Install deps
npm install

# Development (RLM text mode)
npx tsx src/main.ts run --file data.txt "analyze this"

# Development (Swarm mode)
npx tsx src/main.ts --dir ./my-project "add error handling"

# Build
npm run build
```

## Architecture

- `src/main.ts` — CLI entry point, routes to swarm/run/interactive/viewer/benchmark
- `src/swarm.ts` — Swarm mode: scans repo, sets up threads, runs RLM loop with orchestrator prompt
- `src/core/rlm.ts` — Core RLM loop (Algorithm 1 from arXiv:2512.24601)
- `src/core/repl.ts` — Python REPL bridge (line-delimited JSON over stdin/stdout)
- `src/core/runtime.py` — Python runtime with thread(), async_thread(), merge_threads()
- `src/agents/` — Agent backends (opencode, claude-code, codex, aider, direct-llm)
- `src/routing/model-router.ts` — Auto model/agent selection based on task complexity
- `src/threads/manager.ts` — Thread lifecycle + concurrency
- `src/worktree/` — Git worktree CRUD + merge
- `src/compression/` — Result compression strategies (structured, diff-only, truncate, llm-summary)
- `src/prompts/orchestrator.ts` — Swarm orchestrator system prompt with agent capabilities

## Key Design

Python REPL primitives:
- `llm_query(sub_context, instruction)` — lightweight LLM call
- `thread(task, context, agent, model, files)` — spawn coding agent in worktree
- `async_thread(...)` — async version for asyncio.gather()
- `merge_threads()` — merge completed thread branches
- `FINAL(answer)` — return result

JSON protocol between Python and TypeScript:
- `thread_request` / `thread_result` — thread spawn/completion
- `merge_request` / `merge_result` — branch merging
- `llm_query` / `llm_result` — sub-queries (inherited from rlm-cli)

## Config

`swarm_config.yaml` at project root. Key settings:
- `max_threads`: concurrent thread limit (default: 5)
- `default_agent`: agent backend (default: opencode). Options: opencode, claude-code, codex, aider, direct-llm
- `auto_model_selection`: enable auto-routing (default: false). CLI: `--auto-route`
- `compression_strategy`: structured | diff-only | truncate | llm-summary
