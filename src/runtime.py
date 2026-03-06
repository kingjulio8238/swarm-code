"""
RLM Runtime — Python-side helpers for the Recursive Language Model CLI.

This module runs in a persistent Python subprocess. It provides:
  - `context`: the full prompt/document as a string variable
  - `llm_query(sub_context, instruction)`: bridge to parent LLM for sub-queries
  - `FINAL(x)`: set final answer string and terminate loop
  - `FINAL_VAR(x)`: set final answer from a variable

Communication protocol (line-delimited JSON over stdio):
  -> stdout: {"type":"llm_query","sub_context":"...","instruction":"...","id":"..."}
  <- stdin:  {"type":"llm_result","id":"...","result":"..."}
  -> stdout: {"type":"exec_done","stdout":"...","stderr":"...","has_final":bool,"final_value":"..."|null}

All protocol I/O uses saved references to the original sys.stdout/sys.stdin
so that exec'd code can freely redirect sys.stdout for print() capture.
"""

import json
import sys
import uuid
import io
import traceback
import asyncio
import threading

# Real stdio handles — saved before exec() can redirect sys.stdout/sys.stderr.
_real_stdout = sys.stdout
_real_stdin = sys.stdin

# Lock + pending results for thread-safe concurrent llm_query calls
_io_lock = threading.Lock()
_pending_results: dict[str, threading.Event] = {}
_result_store: dict[str, str] = {}

# Will be set by the TypeScript host before each execution
context: str = ""

# Sentinel — when set to a non-None value, the loop terminates
__final_result__ = None

# User execution namespace — isolates LLM code from REPL internals
_user_ns: dict = {}


def FINAL(x):
    """Set the final answer as a string and terminate the RLM loop."""
    global __final_result__
    if __final_result__ is not None:
        print(f"[Warning] FINAL() called again — overwriting previous answer", file=sys.stderr)
    __final_result__ = str(x)


def FINAL_VAR(x):
    """Set the final answer from a variable and terminate the RLM loop."""
    global __final_result__
    if __final_result__ is not None and x is not None:
        print(f"[Warning] FINAL_VAR() called again — overwriting previous answer", file=sys.stderr)
    __final_result__ = str(x) if x is not None else None


def _dispatch_stdin_line(line: str) -> None:
    """Route an incoming JSON message to the correct waiting llm_query thread."""
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        return
    if msg.get("type") == "shutdown":
        sys.exit(0)
    if msg.get("type") == "llm_result":
        rid = msg.get("id", "")
        if rid in _pending_results:
            _result_store[rid] = msg.get("result", "")
            _pending_results[rid].set()


def llm_query(sub_context: str, instruction: str = "") -> str:
    """Send a sub-context and instruction to the parent LLM and return the response.

    Thread-safe: multiple concurrent calls (via async_llm_query + asyncio.gather)
    are dispatched correctly using per-request events.
    """
    if not instruction:
        instruction = ""

    request_id = uuid.uuid4().hex[:12]
    event = threading.Event()
    _pending_results[request_id] = event

    request = {
        "type": "llm_query",
        "sub_context": sub_context,
        "instruction": instruction,
        "id": request_id,
    }
    with _io_lock:
        _real_stdout.write(json.dumps(request) + "\n")
        _real_stdout.flush()

    # Read stdin lines and dispatch until OUR result arrives
    while not event.is_set():
        with _io_lock:
            line = _real_stdin.readline()
        if not line:
            _pending_results.pop(request_id, None)
            raise RuntimeError("REPL stdin closed unexpectedly")
        line = line.strip()
        if not line:
            continue
        _dispatch_stdin_line(line)

    _pending_results.pop(request_id, None)
    return _result_store.pop(request_id, "")


async def async_llm_query(sub_context: str, instruction: str = "") -> str:
    """Async wrapper around llm_query for use with asyncio.gather().

    Usage:
        import asyncio
        results = await asyncio.gather(
            async_llm_query(chunk1, "summarize"),
            async_llm_query(chunk2, "summarize"),
        )
    """
    return await asyncio.get_event_loop().run_in_executor(None, llm_query, sub_context, instruction)


def _refresh_user_ns() -> None:
    """Ensure the user namespace has the latest runtime symbols."""
    _user_ns.update({
        '__builtins__': __builtins__,
        'context': context,
        'llm_query': llm_query,
        'async_llm_query': async_llm_query,
        'FINAL': FINAL,
        'FINAL_VAR': FINAL_VAR,
    })


def _execute_code(code: str) -> None:
    """Execute a code snippet in an isolated namespace, capturing output."""
    global __final_result__
    _refresh_user_ns()
    captured_stdout = io.StringIO()
    captured_stderr = io.StringIO()
    old_stdout = sys.stdout
    old_stderr = sys.stderr

    try:
        sys.stdout = captured_stdout
        sys.stderr = captured_stderr
        # Support both sync and async code (await expressions)
        try:
            # Try to compile as regular code first
            compiled = compile(code, "<repl>", "exec")
            exec(compiled, _user_ns)
        except SyntaxError as e:
            if "await" in str(code):
                # Code contains await — run it in an async context
                # We must copy locals back to user namespace so variables persist across iterations
                # But we must NOT clobber runtime-critical symbols
                _protected = {'context', 'llm_query', 'async_llm_query', 'FINAL', 'FINAL_VAR', '__builtins__'}
                async_code = "async def __async_exec__():\n"
                for line in code.split("\n"):
                    async_code += f"    {line}\n"
                async_code += "    return {k: v for k, v in locals().items()}\n"
                async_code += "\nimport asyncio as _asyncio\n"
                async_code += "_async_locals = _asyncio.run(__async_exec__())\n"
                async_code += f"globals().update({{k: v for k, v in _async_locals.items() if k not in {_protected!r}}})\n"
                exec(compile(async_code, "<repl>", "exec"), _user_ns)
            else:
                raise e
    except Exception:
        traceback.print_exc(file=captured_stderr)
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr

    stdout_val = captured_stdout.getvalue()
    stderr_val = captured_stderr.getvalue()

    result = {
        "type": "exec_done",
        "stdout": stdout_val,
        "stderr": stderr_val,
        "has_final": __final_result__ is not None,
        "final_value": str(__final_result__) if __final_result__ is not None else None,
    }
    _real_stdout.write(json.dumps(result) + "\n")
    _real_stdout.flush()


def _main_loop() -> None:
    """Read execution requests from stdin in a loop."""
    while True:
        line = _real_stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        if msg.get("type") == "exec":
            _execute_code(msg.get("code", ""))
        elif msg.get("type") == "set_context":
            global context
            context = msg.get("value", "")
            ack = {"type": "context_set"}
            _real_stdout.write(json.dumps(ack) + "\n")
            _real_stdout.flush()
        elif msg.get("type") == "reset_final":
            global __final_result__
            __final_result__ = None
            ack = {"type": "final_reset"}
            _real_stdout.write(json.dumps(ack) + "\n")
            _real_stdout.flush()
        elif msg.get("type") == "shutdown":
            break


if __name__ == "__main__":
    ready = {"type": "ready"}
    _real_stdout.write(json.dumps(ready) + "\n")
    _real_stdout.flush()
    _main_loop()
