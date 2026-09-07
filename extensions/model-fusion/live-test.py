"""Run one paid four-model coding smoke test in a disposable directory."""

import json
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time


def main():
    root = Path(tempfile.mkdtemp(prefix="pi-fusion-live-"))
    implementation = "def slugify(text):\n    return text.lower().replace(' ', '-')\n"
    tests = '''import unittest
from slug import slugify
class SlugTests(unittest.TestCase):
    def test_cases(self):
        for source, expected in [(" Hello, WORLD! ", "hello-world"), ("a---b__c", "a-b-c"), ("", ""), ("  ", ""), ("a  b", "a-b"), ("A1 B2", "a1-b2"), ("aKb", "a-b")]:
            with self.subTest(source=source): self.assertEqual(slugify(source), expected)
if __name__ == "__main__": unittest.main()
'''
    (root / "slug.py").write_text(implementation)
    (root / "test_slug.py").write_text(tests)
    extension = Path(__file__).resolve().parent
    command = [
        "pi", "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
        "--no-prompt-templates", "--no-context-files", "--no-themes",
        "--provider", "openai-codex", "--model", "gpt-5.6-luna", "--thinking", "low",
        "-e", str(extension / "index.ts"),
        "-e", str(extension.parent / "codex-compaction" / "index.ts"),
    ]
    print(f"Fixture and evidence: {root}", flush=True)
    events = queue.Queue()
    with (root / "stderr.log").open("w") as stderr, (root / "events.jsonl").open("w") as log:
        process = subprocess.Popen(command, cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True)

        def read_events():
            for line in process.stdout:
                try:
                    events.put(json.loads(line))
                except json.JSONDecodeError:
                    continue
            events.put(None)

        threading.Thread(target=read_events, daemon=True).start()

        def send(value):
            process.stdin.write(json.dumps(value) + "\n")
            process.stdin.flush()

        def wait(predicate, timeout=600):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                event = events.get(timeout=max(0.1, deadline - time.monotonic()))
                if event is None:
                    raise RuntimeError(f"Pi exited; inspect {root / 'stderr.log'}")
                log.write(json.dumps(event) + "\n")
                log.flush()
                if event.get("type") == "extension_ui_request" and event.get("method") == "notify":
                    print(event.get("message"), flush=True)
                    if event.get("notifyType") == "error":
                        raise RuntimeError(event.get("message"))
                if event.get("type") == "extension_error":
                    raise RuntimeError(str(event))
                if event.get("type") == "tool_execution_start":
                    print("Tool:", event.get("toolName"), flush=True)
                if predicate(event):
                    return event
            raise TimeoutError("RPC test exceeded deadline")

        try:
            send({"id": "enable", "type": "prompt", "message": "/fusion on"})
            assert wait(lambda event: event.get("id") == "enable", 45)["success"]
            send({"id": "state", "type": "get_state"})
            state = wait(lambda event: event.get("id") == "state", 30)["data"]
            assert state["model"]["provider"] == "openai-codex"
            assert state["model"]["id"] == "gpt-5.6-luna"
            assert state["thinkingLevel"] == "max"
            send({"id": "task", "type": "prompt", "message": (
                "Fix slugify in slug.py so it lowercases ASCII letters, preserves digits, "
                "replaces each run of non-ASCII-alphanumeric characters with one hyphen, "
                "and strips leading/trailing hyphens. Read implementation and tests, edit "
                "only slug.py, and run python3 -m unittest -v. This is an authorized "
                "integration test: call fusion_escalate exactly once with the concrete "
                "edge-case diagnosis to exercise frontier advice, even if you can solve "
                "this small fixture yourself. Verify the advice. Do not modify tests. "
                "Finish with a concise summary."
            )})
            wait(lambda event: event.get("type") == "agent_settled")
            send({"id": "entries", "type": "get_entries"})
            result = wait(lambda event: event.get("id") == "entries", 30)
            (root / "entries.json").write_text(json.dumps(result))
            entries = result["data"]["entries"]
            reviews = [entry["data"] for entry in entries if entry.get("customType") == "model-fusion-review"]
            assert reviews, "No reviewer records"
            expected = {"openrouter/meta/muse-spark-1.3-contributor", "openrouter/z-ai/glm-5.3-flash"}
            assert {review["model"] for review in reviews[0]["reviews"]} == expected
            for review in reviews[0]["reviews"]:
                assert "verdict" in review, f"Reviewer failed: {review}"
                print("Reviewer:", review["model"], review["verdict"]["verdict"], flush=True)
            tools = [entry["message"] for entry in entries if entry.get("type") == "message" and entry["message"].get("role") == "toolResult"]
            frontier = [message for message in tools if message.get("toolName") == "fusion_escalate"]
            assert len(frontier) == 1 and not frontier[0]["isError"], "Expected one successful frontier call"
            assert frontier[0]["details"]["reasoning"] == "low"
            assert frontier[0]["details"]["model"] == "gpt-6-astra"
            assert any(message.get("toolName") in ["write", "edit"] and not message["isError"] for message in tools)
            assert (root / "test_slug.py").read_text() == tests, "Actor modified the test oracle"
            assert (root / "slug.py").read_text() != implementation, "Implementation unchanged"
            subprocess.run(["python3", "-m", "unittest", "-v"], cwd=root, check=True)
            print("Live test passed:", root, flush=True)
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    main()
