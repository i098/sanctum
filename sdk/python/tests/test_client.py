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
            result, expected = call(), case["result"]["ok"]
            # A null expectation is a bodiless success (204); otherwise compare the listed fields.
            self.assertEqual(result if expected is None else {key: result[key] for key in expected}, expected)
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

    def test_non_json_proxy_error_raises_sanctum_error(self) -> None:
        transport = httpx.MockTransport(lambda _: httpx.Response(502, text="<html>Bad Gateway</html>"))
        with Client("https://sanctum.test", transport=transport, max_attempts=1) as client:
            with self.assertRaises(SanctumError) as raised:
                client.health.healthz({})
        self.assertEqual((raised.exception.status, raised.exception.code, raised.exception.body), (502, "http_error", {}))

    def test_pages_follow_cursor_until_null_or_empty(self) -> None:
        first, last = {"meetings": [1, 2], "next_cursor": "o2"}, {"meetings": [3], "next_cursor": None}
        self.assertEqual(self.drain([first, last]), ([1, 2, 3], [None, "o2"]))
        empty = {"meetings": [], "next_cursor": "o3"}
        self.assertEqual(self.drain([first, {**last, "next_cursor": "o3"}, empty]), ([1, 2, 3], [None, "o2", "o3"]))

    def drain(self, pages: list[dict]) -> tuple[list[int], list[str | None]]:
        cursors: list[str | None] = []

        def handle(request: httpx.Request) -> httpx.Response:
            cursors.append(request.url.params.get("cursor"))
            return httpx.Response(200, json=pages.pop(0))

        with Client("https://sanctum.test", transport=httpx.MockTransport(handle)) as client:
            items = [item for page in client.pages("meetings.listMeetings", {"limit": 2}) for item in page["meetings"]]
        return items, cursors

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
