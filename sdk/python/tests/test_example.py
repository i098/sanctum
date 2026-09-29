"""Runs sdk/examples/python/context_workflow.py against the database-free fixture server.

The server is the v1 API over the same fake domain the TypeScript example and MCP tests use
(server/tests/support/fixture-server.ts), so this proves the example end to end over HTTP.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import unittest
import uuid

from sanctum import Client

ROOT = pathlib.Path(__file__).parents[3]
sys.path.insert(0, str(ROOT / "sdk" / "examples" / "python"))

from context_workflow import context_workflow  # noqa: E402


class ContextWorkflowExample(unittest.TestCase):
    def setUp(self) -> None:
        self.server = subprocess.Popen(
            ["node", "server/tests/support/fixture-server.ts"], cwd=ROOT, stdout=subprocess.PIPE, text=True
        )
        self.addCleanup(self.server.wait)
        self.addCleanup(self.server.terminate)
        if self.server.stdout:
            self.addCleanup(self.server.stdout.close)
        line = self.server.stdout.readline() if self.server.stdout else ""
        if not line:
            self.fail("fixture server exited before printing its address")
        self.fixture = json.loads(line)

    def test_workflow_runs_end_to_end(self) -> None:
        def connect(token: str) -> Client:
            client = Client(self.fixture["url"], token)
            self.addCleanup(client.close)
            return client

        run_id = str(uuid.uuid4())
        result = context_workflow(connect(self.fixture["token"]), connect, self.fixture["meeting_id"], run_id)
        self.assertEqual(result["cited"], "We chose option B for the pilot.")
        self.assertTrue(result["retry_returned_same_item"])
        self.assertEqual(result["rebased_revision"], 1)
        self.assertEqual(result["changes"], ["item_added", "item_added"])
        self.assertEqual(result["action_state"], "queued")
        self.assertEqual(result["agent_saw_revision"], 2)
        self.assertEqual(result["after_revoke"], "unauthenticated")


if __name__ == "__main__":
    unittest.main()
