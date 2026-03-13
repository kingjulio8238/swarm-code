# swarm-code

Open-source swarm-native coding agent orchestrator. Fork of rlm-cli extended with parallel coding agent threads in isolated git worktrees.

## Quick Start

```bash
# Install deps
npm install

# Development (Swarm mode)
npx tsx src/main.ts --dir ./my-project "add error handling"

# Development (Interactive mode)
npx tsx src/main.ts --dir ./my-project

# Development (MCP server)
npx tsx src/main.ts mcp --dir ./my-project

# Development (RLM text mode)
npx tsx src/main.ts run --file data.txt "analyze this"

# Build
npm run build
```

## Architecture

- `src/main.ts` — CLI entry point, routes to swarm/run/interactive/viewer/benchmark
- `src/swarm.ts` — Swarm mode: scans repo, sets up threads, runs RLM loop with orchestrator prompt
- `src/interactive-swarm.ts` — Interactive REPL mode with session persistence and live thread monitoring
- `src/core/rlm.ts` — Core RLM loop (Algorithm 1 from arXiv:2512.24601)
- `src/core/repl.ts` — Python REPL bridge (line-delimited JSON over stdin/stdout)
- `src/core/runtime.py` — Python runtime with thread(), async_thread(), merge_threads()
- `src/agents/` — Agent backends (opencode, claude-code, codex, aider, direct-llm)
- `src/routing/model-router.ts` — Auto model/agent selection based on task complexity + named slots + episodic memory + failure tracking (exponential decay)
- `src/threads/manager.ts` — Thread lifecycle + concurrency + subthread caching + episode recording
- `src/threads/cache.ts` — Subthread cache with optional disk persistence and TTL expiry
- `src/memory/episodic.ts` — Episodic memory: persists successful strategies, trigram-based recall, aggregate stats per agent
- `src/worktree/` — Git worktree CRUD + merge
- `src/compression/` — Result compression with episode quality filtering (success-only output)
- `src/prompts/orchestrator.ts` — Swarm orchestrator system prompt with DAG composition examples
- `src/viewer.ts` — Trajectory TUI viewer with swarm thread DAG visualization, timing bars, cost breakdowns
- `src/mcp/` — MCP server: exposes swarm as tools for Claude Code, Cursor, etc. (server, tools, session)
- `src/ui/` — CLI UI components (onboarding wizard, spinner, dashboard, session summary)
- `action/` — GitHub Actions composite action (entrypoint, trigger parsing, security, PR creation)

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
- `model_slot_execution/search/reasoning/planning`: per-slot model overrides (empty = auto-select)
- `episodic_memory_enabled`: enable cross-session strategy learning (default: false)
- `thread_cache_persist`: enable disk persistence for subthread cache (default: false)

## Key Optimizations

- **Episode quality**: Compression filters agent output to only successful operations — failed attempts, stack traces, retries stripped automatically
- **Subthread caching**: Identical threads (same task+files+agent+model) cached in-memory with optional disk persistence and TTL expiry; second call returns instantly
- **Named model slots**: Tasks auto-classified into execution/search/reasoning/planning; each slot has preferred agents and optional model overrides
- **Episodic memory**: Persists successful thread strategies to disk; trigram-based similarity recall informs agent/model selection in future sessions
- **DAG composition**: Thread results compose via Python variable persistence (T1+T2 → T3); orchestrator prompt teaches multi-stage pipelines and failure re-routing
- **Failure tracking**: FailureTracker class uses exponential-decay weighting to penalize recently-failed agent/model pairs in routing decisions
- **Interactive mode**: Session-persistent REPL with /threads, /merge, /reject, /dag, /budget commands and SIGINT handling (single=cancel task, double=exit)
- **GitHub Action**: Composite action triggered by `@swarm` in issue comments or workflow_dispatch. Security: author association check, fork PR rejection, $50 budget hard cap. Creates PRs and posts result comments.
- **MCP server**: Exposes 6 tools (swarm_run, swarm_thread, swarm_status, swarm_merge, swarm_cancel, swarm_cleanup) over stdio transport. Per-directory sessions with lazy-init ThreadManager/WorktreeManager. Claude Code: `claude mcp add swarm-code -- npx swarm-code mcp`
