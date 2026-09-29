"""Replays sdk/fixtures/wire-cases.json, the same golden exchanges the TypeScript SDK replays."""

from __future__ import annotations

import asyncio
import json
import pathlib
import unittest

import httpx

from sanctum import AsyncClient, Client, SanctumError

FIXTURE = json.loads((pathlib.Path(__file__).parents[2] / "fixtures" / "wire-cases.json").read_text())


def replay(exchanges: list[dict]) -> tuple[list[dict], httpx.MockTransport]:
    sent: list[dict] = []

    def handle(request: httpx.Request) -> httpx.Response:
        sent.append(
            {
                "method": request.method,
                "path": request.url.path,
                "query": dict(request.url.params),
                "body": json.loads(request.content) if request.content else None,
                "authorization": request.headers.get("authorization"),
            }
        )
        if len(sent) > len(exchanges):
            raise AssertionError("unexpected extra request")
        response = exchanges[len(sent) - 1]["response"]
        return httpx.Response(response["status"], json=response["body"])

    return sent, httpx.MockTransport(handle)


def expected_requests(case: dict) -> list[dict]:
    return [{**e["request"], "authorization": f"Bearer {FIXTURE['token']}"} for e in case["exchanges"]]


class WireCases(unittest.TestCase):
    def check_outcome(self, case: dict, call) -> None:
        if "ok" in case["result"]:
            result = call()
            for key, value in case["result"]["ok"].items():
                self.assertEqual(result[key], value)
            return
        expected = dict(case["result"]["error"])
        with self.assertRaises(SanctumError) as raised:
            call()
        error = raised.exception
        self.assertEqual((error.status, error.code, error.retryable), (expected.pop("status"), expected.pop("code"), expected.pop("retryable")))
        for key, value in expected.items():
            self.assertEqual(error.body[key], value)

    def test_sync_client_matches_fixture(self) -> None:
        for case in FIXTURE["cases"]:
            with self.subTest(case["name"]):
                sent, transport = replay(case["exchanges"])
                with Client("https://sanctum.test", FIXTURE["token"], transport=transport, retry_delay_ms=1) as client:
                    self.check_outcome(case, lambda: client.call(case["operation"], case["input"]))
                self.assertEqual(sent, expected_requests(case))

    def test_async_client_matches_fixture(self) -> None:
        async def run(case: dict, transport: httpx.MockTransport):
            async with AsyncClient("https://sanctum.test", FIXTURE["token"], transport=transport, retry_delay_ms=1) as client:
                return await client.call(case["operation"], case["input"])

        for case in FIXTURE["cases"]:
            with self.subTest(case["name"]):
                sent, transport = replay(case["exchanges"])
                self.check_outcome(case, lambda: asyncio.run(run(case, transport)))
                self.assertEqual(sent, expected_requests(case))


class Transport(unittest.TestCase):
    def test_retries_reads_after_network_failure_then_gives_up(self) -> None:
        calls = 0

        def flaky(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if calls < 3:
                raise httpx.ConnectError("down", request=request)
            return httpx.Response(200, json={"status": "ok"})

        with Client("https://sanctum.test", transport=httpx.MockTransport(flaky), retry_delay_ms=1) as client:
            self.assertEqual(client.health.healthz({}), {"status": "ok"})
        self.assertEqual(calls, 3)

        calls = 0
        with Client("https://sanctum.test", transport=httpx.MockTransport(flaky), retry_delay_ms=1, max_attempts=2) as client:
            with self.assertRaises(httpx.ConnectError):
                client.health.healthz({})

    def test_pages_follow_cursor_until_null(self) -> None:
        pages = [{"items": [1, 2], "next_cursor": "o2"}, {"items": [3], "next_cursor": None}]
        cursors: list[str | None] = []

        def handle(request: httpx.Request) -> httpx.Response:
            cursors.append(request.url.params.get("cursor"))
            return httpx.Response(200, json=pages.pop(0))

        with Client("https://sanctum.test", transport=httpx.MockTransport(handle)) as client:
            items = [item for page in client.pages("meetings.listMeetings", {"limit": 2}) for item in page["items"]]
        self.assertEqual(items, [1, 2, 3])
        self.assertEqual(cursors, [None, "o2"])

    def test_waits_for_terminal_action_receipt(self) -> None:
        states = ["queued", "running", "succeeded"]
        transport = httpx.MockTransport(lambda _: httpx.Response(200, json={"action_id": "a", "state": states.pop(0)}))
        with Client("https://sanctum.test", transport=transport) as client:
            self.assertEqual(client.wait_for_action("a", interval=0)["state"], "succeeded")

    def test_cancelling_the_task_aborts_an_async_request(self) -> None:
        started = asyncio.Event()

        async def hang(_: httpx.Request) -> httpx.Response:
            started.set()
            await asyncio.sleep(3600)
            raise AssertionError("not cancelled")

        async def run() -> None:
            async with AsyncClient("https://sanctum.test", transport=httpx.MockTransport(hang)) as client:
                task = asyncio.create_task(client.health.healthz({}))
                await started.wait()
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
