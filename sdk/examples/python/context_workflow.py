"""End-to-end agent workflow with the Python SDK; the same steps as the TypeScript example.

    SANCTUM_URL=https://sanctum.example SANCTUM_TOKEN=... python context_workflow.py <meeting_id>

The token must carry ``workspace:admin`` for the agent steps. The action is only requested:
it executes later, and only under a stored grant.
"""

from __future__ import annotations

import os
import sys
import uuid
from collections.abc import Callable
from typing import Any

from sanctum import Client, SanctumError


def context_workflow(admin: Client, connect: Callable[[str], Client], meeting_id: str, run_id: str) -> dict[str, Any]:
    # 1. Read the meeting and the first transcript segment; cite it by ID.
    meeting = admin.meetings.get_meeting({"meeting_id": meeting_id})
    first_page = next(admin.pages("meetings.getTranscript", {"meeting_id": meeting_id, "limit": 1}))
    if not first_page["items"]:
        raise RuntimeError("Meeting has no final transcript yet")
    segment = first_page["items"][0]
    source = admin.context.get_source({"source_id": segment["id"]})

    # 2. Append a research observation at the snapshot revision; a retry with the same key is a no-op.
    context = admin.context.get_context({"meeting_id": meeting_id})
    observation = {
        "meeting_id": meeting_id,
        "expected_revision": context["revision"],
        "kind": "research_observation",
        "text": f"Cited: {source['text']}",
        "sources": [{"segment_id": segment["id"], "start_ms": 0, "end_ms": 1_000}],
        "idempotency_key": f"{run_id}:observation",
    }
    added = admin.context.add_context_item(observation)
    retried = admin.context.add_context_item(observation)

    # 3. A write against the old revision conflicts; rebase on current_revision instead of overwriting.
    rebased_revision = None
    try:
        admin.context.add_context_item({**observation, "text": "Stale follow-up", "idempotency_key": f"{run_id}:stale"})
    except SanctumError as error:
        if error.code != "revision_conflict":
            raise
        rebased_revision = error.body["current_revision"]
        admin.context.add_context_item(
            {**observation, "expected_revision": rebased_revision, "text": "Rebased follow-up", "idempotency_key": f"{run_id}:rebased"}
        )

    # 4. Consume durable changes after the snapshot's cursor.
    changes = admin.context.get_context_changes({"meeting_id": meeting_id, "cursor": context["changes_cursor"]})

    # 5. Discover one integration action, inspect it, request it and read the receipt.
    matches = admin.integrations.search_integration_actions({"intent": "tracking issue", "limit": 1})["matches"]
    if not matches:
        raise RuntimeError("No integration action matches")
    inspected = admin.integrations.get_integration_action({"action_key": matches[0]["action_key"]})
    requested = admin.actions.request_action(
        {
            "action_key": inspected["action_key"],
            "configuration_ref": inspected["configuration_ref"],
            "version": inspected["version"],
            "arguments": {"title": f"Follow up: {meeting['title'] or 'meeting'}"},
            "meeting_id": meeting_id,
            "idempotency_key": f"{run_id}:action",
        }
    )
    receipt = admin.actions.get_action({"action_id": requested["action_id"]})

    # 6. Create a read-only agent credential, use it, revoke it, and observe the refusal.
    created = admin.agents.create_agent(
        {"display_name": f"Reader {run_id}", "scopes": ["context:read"], "meeting_ids": [meeting_id], "expires_at": None}
    )
    agent = connect(created["token"])
    agent_revision = agent.context.get_context({"meeting_id": meeting_id})["revision"]
    admin.agents.revoke_credential(
        {"agent_id": created["credential"]["agent_id"], "credential_id": created["credential"]["credential_id"]}
    )
    try:
        agent.context.get_context({"meeting_id": meeting_id})
        after_revoke = "still allowed"
    except SanctumError as error:
        after_revoke = error.code

    return {
        "meeting": meeting["title"],
        "cited": source["text"],
        "added_id": added["id"],
        "retry_returned_same_item": retried["id"] == added["id"],
        "rebased_revision": rebased_revision,
        "changes": [change["change"] for change in changes["items"]],
        "action_state": receipt["state"],
        "agent_saw_revision": agent_revision,
        "after_revoke": after_revoke,
    }


if __name__ == "__main__":
    import json

    if len(sys.argv) != 2 or "SANCTUM_URL" not in os.environ:
        sys.exit("Usage: SANCTUM_URL=... SANCTUM_TOKEN=... python context_workflow.py <meeting_id>")
    base_url = os.environ["SANCTUM_URL"]

    def connect(token: str) -> Client:
        return Client(base_url, token)

    result = context_workflow(connect(os.environ.get("SANCTUM_TOKEN", "")), connect, sys.argv[1], str(uuid.uuid4()))
    print(json.dumps(result, indent=2))
