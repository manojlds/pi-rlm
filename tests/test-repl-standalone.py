#!/usr/bin/env python3
"""
Standalone REPL machinery tests — no pi CLI or API keys needed.

Tests that the Python REPL driver:
  1. Starts and signals READY
  2. Executes Python code and returns results
  3. Handles FINAL() / SUBMIT() correctly
  4. Maintains persistent state across executions
  5. Context variable is loaded from file
  6. Error handling works
  7. Scaffold functions can't be overwritten
"""

import subprocess
import json
import os
import sys
import tempfile
import time

GREEN = "\033[0;32m"
RED = "\033[0;31m"
NC = "\033[0m"

PASS = 0
FAIL = 0


def log_pass(msg):
    global PASS
    print(f"{GREEN}✓ PASS{NC}: {msg}")
    PASS += 1


def log_fail(msg, detail=""):
    global FAIL
    print(f"{RED}✗ FAIL{NC}: {msg} — {detail}")
    FAIL += 1


# ── Build the REPL driver script (mirrors rlm-engine.ts buildDriverScript) ──

def build_driver(context_path: str, server_port: int = 9999) -> str:
    return f'''
import sys
import io
import json
import traceback

with open({json.dumps(context_path)}, 'r') as f:
    context = f.read()

def llm_query(prompt, model=None):
    return f"[MOCK LLM] {{prompt[:50]}}"

def llm_query_batched(prompts, model=None):
    return [llm_query(p) for p in prompts]

def rlm_query(prompt, model=None):
    return f"[MOCK RLM] {{prompt[:50]}}"

def rlm_query_batched(prompts, model=None):
    return [rlm_query(p) for p in prompts]

def SHOW_VARS():
    user_vars = {{k: repr(v)[:100] for k, v in _namespace.items()
                 if not k.startswith('_') and k not in _reserved}}
    return user_vars

_final_answer = None
_final_var = None

def FINAL(answer):
    global _final_answer, _final_var
    _final_answer = str(answer)
    _final_var = None

def FINAL_VAR(var_name):
    global _final_answer, _final_var
    _final_var = str(var_name)
    _final_answer = None

def SUBMIT(answer):
    FINAL(answer)

_reserved = {{'context', 'llm_query', 'llm_query_batched', 'rlm_query', 'rlm_query_batched',
             'SHOW_VARS', 'FINAL', 'FINAL_VAR', 'SUBMIT', 'print', '__builtins__'}}

_namespace = {{
    'context': context,
    'llm_query': llm_query,
    'llm_query_batched': llm_query_batched,
    'rlm_query': rlm_query,
    'rlm_query_batched': rlm_query_batched,
    'SHOW_VARS': SHOW_VARS,
    'FINAL': FINAL,
    'FINAL_VAR': FINAL_VAR,
    'SUBMIT': SUBMIT,
    '__builtins__': __builtins__,
}}

print("__REPL_READY__", flush=True)

buffer = ""
while True:
    try:
        line = sys.stdin.readline()
        if not line:
            break
        buffer += line
        if "__REPL_EXEC__" not in buffer:
            continue

        msg_text = buffer.split("__REPL_EXEC__")[0].strip()
        buffer = ""

        msg = json.loads(msg_text)
        code = msg.get("code", "")

        _final_answer = None
        _final_var = None

        old_stdout = sys.stdout
        old_stderr = sys.stderr
        captured_stdout = io.StringIO()
        captured_stderr = io.StringIO()
        sys.stdout = captured_stdout
        sys.stderr = captured_stderr

        error = None
        try:
            exec(code, _namespace)
        except Exception as e:
            error = traceback.format_exc()

        # Restore scaffold after exec
        _namespace['context'] = context
        _namespace['llm_query'] = llm_query
        _namespace['llm_query_batched'] = llm_query_batched
        _namespace['rlm_query'] = rlm_query
        _namespace['rlm_query_batched'] = rlm_query_batched
        _namespace['SHOW_VARS'] = SHOW_VARS
        _namespace['FINAL'] = FINAL
        _namespace['FINAL_VAR'] = FINAL_VAR
        _namespace['SUBMIT'] = SUBMIT

        sys.stdout = old_stdout
        sys.stderr = old_stderr

        stdout_text = captured_stdout.getvalue()
        stderr_text = captured_stderr.getvalue()
        if error:
            stderr_text += error

        final_var_value = None
        if _final_var and _final_var in _namespace:
            final_var_value = str(_namespace[_final_var])

        result = {{
            "stdout": stdout_text,
            "stderr": stderr_text,
            "final_answer": _final_answer,
            "final_var": final_var_value,
            "submitted": _final_answer,
            "error": error,
            "show_vars": SHOW_VARS() if 'SHOW_VARS' in code else None,
        }}

        print(stdout_text, end="", flush=True)
        print("__REPL_RESULT_START__", flush=True)
        print(json.dumps(result), flush=True)
        print("__REPL_RESULT_END__", flush=True)

    except Exception as e:
        sys.stdout = sys.__stdout__
        sys.stderr = sys.__stderr__
        print("__REPL_RESULT_START__", flush=True)
        print(json.dumps({{"stdout": "", "stderr": str(e), "final_answer": None, "submitted": None, "error": str(e)}}), flush=True)
        print("__REPL_RESULT_END__", flush=True)
'''


class REPLDriver:
    """Manages a persistent Python REPL subprocess."""

    def __init__(self, context_text: str):
        self.tmpdir = tempfile.mkdtemp(prefix="rlm-test-")
        self.context_path = os.path.join(self.tmpdir, "context.txt")
        self.driver_path = os.path.join(self.tmpdir, "driver.py")

        with open(self.context_path, "w") as f:
            f.write(context_text)

        with open(self.driver_path, "w") as f:
            f.write(build_driver(self.context_path))

        self.proc = subprocess.Popen(
            ["python3", self.driver_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=self.tmpdir,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )

        # Wait for READY
        self._wait_for_ready()

    def _wait_for_ready(self):
        deadline = time.time() + 10
        buf = b""
        while time.time() < deadline:
            chunk = self.proc.stdout.read1(4096) if hasattr(self.proc.stdout, 'read1') else self.proc.stdout.readline()
            buf += chunk
            if b"__REPL_READY__" in buf:
                return
        raise TimeoutError("REPL did not send READY signal within 10s")

    def execute(self, code: str) -> dict:
        """Send code to the REPL and return the parsed result dict."""
        msg = json.dumps({"code": code}) + "\n__REPL_EXEC__\n"
        self.proc.stdin.write(msg.encode())
        self.proc.stdin.flush()

        # Read until we get the result markers
        buf = b""
        deadline = time.time() + 30
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                break
            buf += line
            if b"__REPL_RESULT_END__" in buf:
                break

        text = buf.decode("utf-8")
        start = text.rfind("__REPL_RESULT_START__")
        end = text.find("__REPL_RESULT_END__")
        if start >= 0 and end > start:
            json_str = text[start + len("__REPL_RESULT_START__"):end].strip()
            return json.loads(json_str)

        return {"error": "Failed to parse result", "stdout": text, "stderr": ""}

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)


# ── Test Cases ──────────────────────────────────────────────────────────

def main():
    print("╔══════════════════════════════════════════════╗")
    print("║   Standalone REPL Machinery Tests            ║")
    print("╚══════════════════════════════════════════════╝")
    print()

    context = "This is test context. The hidden number is 12345. More text follows." * 100

    repl = REPLDriver(context)

    try:
        # Test 1: REPL starts
        log_pass("REPL starts and signals READY")

        # Test 2: Basic execution
        r = repl.execute("print(2 + 2)")
        if r["stdout"].strip() == "4":
            log_pass("Basic execution: print(2+2) = 4")
        else:
            log_fail("Basic execution", f"Expected '4', got '{r['stdout'].strip()}'")

        # Test 3: Context loaded
        r = repl.execute("print(len(context))")
        ctx_len = r["stdout"].strip()
        if ctx_len.isdigit() and int(ctx_len) > 0:
            log_pass(f"Context loaded: len(context) = {ctx_len}")
        else:
            log_fail("Context loaded", f"Expected positive number, got '{ctx_len}'")

        # Test 4: Context is searchable
        r = repl.execute("print('12345' in context)")
        if r["stdout"].strip() == "True":
            log_pass("Context searchable: found '12345' in context")
        else:
            log_fail("Context searchable", f"Expected 'True', got '{r['stdout'].strip()}'")

        # Test 5: Regex search in context
        r = repl.execute("import re; matches = re.findall(r'\\d{5}', context); print(len(matches))")
        count = r["stdout"].strip()
        if count.isdigit() and int(count) > 0:
            log_pass(f"Regex works in REPL: found {count} 5-digit matches")
        else:
            log_fail("Regex", f"Expected matches, got '{count}'")

        # Test 6: Persistent state
        repl.execute("my_var = 42")
        r = repl.execute("print(my_var * 2)")
        if r["stdout"].strip() == "84":
            log_pass("Persistent state: my_var persists across executions")
        else:
            log_fail("Persistent state", f"Expected '84', got '{r['stdout'].strip()}'")

        # Test 7: FINAL() sets final_answer
        r = repl.execute('FINAL("the answer is 42")')
        if r.get("final_answer") == "the answer is 42":
            log_pass("FINAL() works: final_answer set correctly")
        else:
            log_fail("FINAL()", f"Expected 'the answer is 42', got '{r.get('final_answer')}'")

        # Test 8: SUBMIT() alias
        r = repl.execute('SUBMIT("submitted value")')
        if r.get("submitted") == "submitted value":
            log_pass("SUBMIT() alias works")
        else:
            log_fail("SUBMIT()", f"Expected 'submitted value', got '{r.get('submitted')}'")

        # Test 9: FINAL_VAR()
        repl.execute("answer = 'computed result'")
        r = repl.execute('FINAL_VAR("answer")')
        if r.get("final_var") == "computed result":
            log_pass("FINAL_VAR() works: returns variable value")
        else:
            log_fail("FINAL_VAR()", f"Expected 'computed result', got '{r.get('final_var')}'")

        # Test 10: llm_query callable
        r = repl.execute('r = llm_query("test prompt"); print(r)')
        if "[MOCK LLM]" in r["stdout"]:
            log_pass("llm_query() callable from REPL")
        else:
            log_fail("llm_query()", f"Expected mock response, got '{r['stdout'].strip()}'")

        # Test 11: llm_query_batched
        r = repl.execute('results = llm_query_batched(["q1", "q2", "q3"]); print(len(results))')
        if r["stdout"].strip() == "3":
            log_pass("llm_query_batched() returns correct count")
        else:
            log_fail("llm_query_batched()", f"Expected '3', got '{r['stdout'].strip()}'")

        # Test 12: rlm_query callable
        r = repl.execute('r = rlm_query("test prompt"); print(r)')
        if "[MOCK RLM]" in r["stdout"]:
            log_pass("rlm_query() callable from REPL")
        else:
            log_fail("rlm_query()", f"Expected mock response, got '{r['stdout'].strip()}'")

        # Test 13: Error handling
        r = repl.execute("x = 1 / 0")
        if r.get("error"):
            log_pass("Error handling: ZeroDivisionError caught")
        else:
            log_fail("Error handling", "Expected error to be set")

        # Test 14: State survives errors
        r = repl.execute("print(my_var)")
        if r["stdout"].strip() == "42":
            log_pass("State survives errors: my_var still = 42")
        else:
            log_fail("State survives errors", f"Expected '42', got '{r['stdout'].strip()}'")

        # Test 15: Scaffold restoration
        repl.execute('llm_query = "overwritten"')
        r = repl.execute('r = llm_query("after overwrite"); print(r)')
        if "[MOCK LLM]" in r["stdout"]:
            log_pass("Scaffold restoration: llm_query restored after overwrite")
        else:
            log_fail("Scaffold restoration", f"Got '{r['stdout'].strip()}'")

        # Test 16: Context restoration
        repl.execute('context = "corrupted"')
        r = repl.execute('print("12345" in context)')
        if r["stdout"].strip() == "True":
            log_pass("Context restoration: context restored after overwrite")
        else:
            log_fail("Context restoration", f"Expected 'True', got '{r['stdout'].strip()}'")

        # Test 17: SHOW_VARS
        repl.execute("result_data = [1, 2, 3]")
        r = repl.execute("SHOW_VARS()")
        if r.get("show_vars") and "result_data" in r["show_vars"]:
            log_pass("SHOW_VARS() lists user variables")
        else:
            log_fail("SHOW_VARS()", f"Expected 'result_data' in vars, got '{r.get('show_vars')}'")

        # Test 18: Computation that LLMs can't do
        r = repl.execute("import hashlib; h = hashlib.sha256(b'test').hexdigest(); print(h)")
        expected_hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        if r["stdout"].strip() == expected_hash:
            log_pass("SHA256 computation: correct hash (proves code execution)")
        else:
            log_fail("SHA256 computation", f"Expected '{expected_hash}', got '{r['stdout'].strip()}'")

    finally:
        repl.close()

    print()
    print("═══════════════════════════════════════════════")
    print(f"Results: {GREEN}{PASS} passed{NC}, {RED}{FAIL} failed{NC}")
    print("═══════════════════════════════════════════════")

    sys.exit(FAIL)


if __name__ == "__main__":
    main()
