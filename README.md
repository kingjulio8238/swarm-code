# swarm-cli

Open-source swarm-native coding agent orchestrator. Spawns parallel coding agents in isolated git worktrees, orchestrated by a Recursive Language Model (based on [arXiv:2512.24601](https://arxiv.org/abs/2512.24601)).

## Install

```bash
npm install -g swarm-cli
```

Requires **Node.js >= 20** and **Python 3**.

### Supported Providers

| Provider | Env Variable | Default Model |
|----------|-------------|---------------|
| **Anthropic** | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| **OpenAI** | `OPENAI_API_KEY` | `gpt-4o` |
| **Google** | `GEMINI_API_KEY` | `gemini-2.5-flash` |

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### From Source

```bash
git clone https://github.com/kingjulio8238/swarm-code.git
cd swarm-code
npm install
npm run build
npm link
```

## Usage

### Swarm Mode — Parallel Coding Agents

Point swarm at a repo with a task. It scans the codebase, decomposes the work, and spawns coding agents in isolated git worktrees:

```bash
swarm --dir ./my-project "add error handling to all API routes"
```

The orchestrator LLM writes Python code that calls `thread()` to spawn agents, `asyncio.gather()` for parallelism, and `merge_threads()` to integrate changes:

```bash
# With auto model routing (picks best agent+model per task)
swarm --dir ./project --auto-route "migrate from Express to Fastify"

# Dry run — plan without executing
swarm --dir ./project --dry-run "refactor auth module"

# Budget cap
swarm --dir ./project --max-budget 5.00 "add comprehensive tests"

# Specific agent backend
swarm --dir ./project --agent claude-code "review and fix security issues"

# Verbose — see routing decisions and memory hints
swarm --dir ./project --verbose --auto-route "optimize database queries"
```

### Agent Backends

| Agent | Description | Best for |
|-------|------------|----------|
| `opencode` (default) | Open-source, multi-provider, tool-capable | General coding, testing |
| `claude-code` | Anthropic's Claude Code CLI | Deep analysis, refactoring |
| `codex` | OpenAI's Codex CLI | Shell commands, OpenAI models |
| `aider` | Git-aware AI coding assistant | Targeted edits, minimal changes |
| `direct-llm` | Bare LLM call, no agent wrapper | Analysis, planning, classification |

### RLM Text Mode (inherited)

The original RLM text-processing mode is preserved:

```bash
swarm run --file large-document.txt "summarize the key findings"
swarm run --url https://example.com/data.txt "extract all dates"
cat data.txt | swarm run --stdin "count the errors"
```

### Trajectory Viewer

```bash
swarm viewer
```

Browse saved runs in a TUI. View iterations, code, output, sub-queries, and swarm thread DAGs.

### Benchmarks

```bash
swarm benchmark oolong          # Oolong Synth long-context benchmark
swarm benchmark longbench       # LongBench NarrativeQA benchmark
```

## How It Works

1. **Scan**: Codebase is scanned and loaded as context
2. **Orchestrate**: The RLM loop runs — the LLM writes Python code using swarm primitives
3. **Decompose**: Tasks are broken into independent, parallelizable units
4. **Spawn**: `thread()` / `async_thread()` spawn coding agents in isolated git worktrees
5. **Compress**: Agent output is filtered to successful operations only (episode quality)
6. **Merge**: `merge_threads()` integrates worktree branches back to main
7. **Verify**: Optional test thread validates the merged result

### Python Primitives

```python
# Lightweight LLM query (no file changes)
analysis = llm_query(context[:5000], "List all API endpoints")

# Spawn a coding agent in an isolated worktree
result = thread("Fix the auth bug", files=["src/auth.ts"])

# Parallel threads
import asyncio
results = await asyncio.gather(
    async_thread("Add validation to POST /users", files=["src/routes/users.ts"]),
    async_thread("Add validation to POST /orders", files=["src/routes/orders.ts"]),
)

# Merge all thread branches back to main
merge_threads()

# Return final answer
FINAL("Added input validation to all API routes")
```

### Thread DAG Composition

Thread results compose naturally via Python variable persistence:

```python
# Stage 1: Research in parallel
analysis, test_gaps = await asyncio.gather(
    async_thread("Analyze the auth module", files=["src/auth/"]),
    async_thread("Find files with <50% coverage", files=["package.json"]),
)

# Stage 2: Act on Stage 1 results
await asyncio.gather(
    async_thread("Add rate limiting", context=analysis, files=["src/auth/middleware.ts"]),
    async_thread("Add tests for low-coverage files", context=test_gaps),
)

# Stage 3: Merge and validate
merge_threads()
thread("Run full test suite and fix failures")
```

## Configuration

Create `swarm_config.yaml` in your project root:

```yaml
# Concurrency
max_threads: 5                    # Max concurrent threads
max_total_threads: 20             # Max threads per session
thread_timeout_ms: 300000         # 5min per thread

# Budget
max_thread_budget_usd: 1.00      # Per-thread cost cap
max_session_budget_usd: 10.00    # Total session cost cap

# Agent
default_agent: opencode           # opencode, claude-code, codex, aider, direct-llm
default_model: anthropic/claude-sonnet-4-6
auto_model_selection: false       # Enable auto-routing

# Compression
compression_strategy: structured  # structured, diff-only, truncate, llm-summary

# Model slots — override model per task type
# model_slot_execution: anthropic/claude-sonnet-4-6
# model_slot_search: anthropic/claude-haiku-4-5
# model_slot_reasoning: anthropic/claude-opus-4-6
# model_slot_planning: anthropic/claude-opus-4-6

# Episodic memory — cross-session strategy learning
episodic_memory_enabled: false
memory_dir: ~/.swarm/memory

# Thread cache persistence
thread_cache_persist: false
thread_cache_dir: ~/.swarm/cache
thread_cache_ttl_hours: 24
```

## Key Optimizations

- **Episode quality**: Compression filters agent output to only successful operations — failed attempts, stack traces, and retries are stripped automatically
- **Subthread caching**: Identical threads (same task + files + agent + model) are cached in-memory with optional disk persistence and TTL expiry
- **Named model slots**: Tasks auto-classified into execution/search/reasoning/planning slots, each with preferred agents and optional model overrides
- **Episodic memory**: Persists successful thread strategies to disk; trigram-based similarity recall informs agent/model selection in future sessions
- **DAG composition**: Thread results compose via Python variable persistence (T1+T2 → T3); orchestrator prompt teaches multi-stage pipelines and failure re-routing

## License

MIT
