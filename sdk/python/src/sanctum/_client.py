"""Thin HTTPX client for the Sanctum v1 API (plan section 13).

Operations and DTOs are generated from the OpenAPI document into ``_generated.py``; this
module holds the handwritten parts: typed errors, safe retries, cursor pages and receipts.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import AsyncIterator, Callable, Iterator, Mapping
from types import SimpleNamespace
from typing import Any
from urllib.parse import quote

import httpx

from ._generated import OPERATIONS, ActionReceipt, Operation

TERMINAL_ACTION_STATES = frozenset({"succeeded", "failed", "cancelled", "unknown"})


class SanctumError(Exception):
    """Error envelope shared by REST, SDKs and MCP; ``body`` keeps typed details."""

    def __init__(self, status: int, body: Mapping[str, Any]) -> None:
        super().__init__(body.get("message", f"HTTP {status}"))
        self.status = status
        self.body = dict(body)
        self.code: str = body.get("code", "http_error")
        self.retryable = body.get("retryable") is True or status == 429


def _request(operation: str, input: Mapping[str, Any]) -> tuple[Operation, str, dict[str, str], Any]:
    op = OPERATIONS[operation]
    path = op.path
    for name in op.path_params:
        path = path.replace("{" + name + "}", quote(str(input[name]), safe=""))
    params = {name: str(input[name]) for name in op.query_params if input.get(name) is not None}
    fields = {k: v for k, v in input.items() if k not in op.path_params and k not in op.query_params}
    return op, path, params, fields if op.body else None


def _parse(response: httpx.Response) -> Any:
    if response.is_success:
        return response.json() if response.content else None
    try:
        body = response.json()
    except ValueError:
        body = None
    raise SanctumError(response.status_code, body if isinstance(body, dict) else {})


def _retry_delay(error: Exception, safe: bool, attempt: int, max_attempts: int, base_ms: int) -> float | None:
    """Seconds to wait before retrying, or None when the error is final."""
    transient = isinstance(error, httpx.TransportError) or (isinstance(error, SanctumError) and error.retryable)
    if not (safe and transient and attempt < max_attempts):
        return None
    hinted = error.body.get("retry_after_ms") if isinstance(error, SanctumError) else None
    return (hinted if isinstance(hinted, int) else base_ms * 2 ** (attempt - 1)) / 1000


def _is_safe(op: Operation, input: Mapping[str, Any]) -> bool:
    # Reads, and writes the server deduplicates by idempotency key.
    return op.method == "GET" or isinstance(input.get("idempotency_key"), str)


def _is_last(page: Mapping[str, Any]) -> bool:
    """A null cursor or an empty page ends paging; each operation names its own list (``meetings``, ``events``, ...)."""
    return page["next_cursor"] is None or not any(isinstance(value, list) and value for value in page.values())


def _groups(call: Callable[[str, Mapping[str, Any]], Any]) -> dict[str, SimpleNamespace]:
    """`client.<group>.<snake_case_operation>(input)` for every generated operation ID."""
    groups: dict[str, SimpleNamespace] = {}
    for operation in OPERATIONS:
        group, name = operation.split(".")
        method = re.sub(r"[A-Z]", lambda m: "_" + m.group().lower(), name)
        setattr(groups.setdefault(group, SimpleNamespace()), method, lambda input, op=operation: call(op, input))
    return groups


def _headers(token: str | None) -> dict[str, str]:
    return {"accept": "application/json", **({"authorization": f"Bearer {token}"} if token else {})}


class Client:
    """Synchronous client: ``client.context.get_context({"meeting_id": ...})``."""

    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        *,
        max_attempts: int = 3,
        retry_delay_ms: int = 200,
        timeout: float = 30.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._http = httpx.Client(base_url=base_url, headers=_headers(token), timeout=timeout, transport=transport)
        self._max_attempts = max_attempts
        self._retry_delay_ms = retry_delay_ms
        self.__dict__.update(_groups(self.call))

    def call(self, operation: str, input: Mapping[str, Any]) -> Any:
        op, path, params, body = _request(operation, input)
        for attempt in range(1, self._max_attempts + 1):
            try:
                return _parse(self._http.request(op.method, path, params=params, json=body))
            except (httpx.TransportError, SanctumError) as error:
                delay = _retry_delay(error, _is_safe(op, input), attempt, self._max_attempts, self._retry_delay_ms)
                if delay is None:
                    raise
                time.sleep(delay)
        raise AssertionError("unreachable")

    def pages(self, operation: str, input: Mapping[str, Any]) -> Iterator[dict[str, Any]]:
        """Cursor pages in order; stops on a null cursor or an empty page."""
        request = dict(input)
        while True:
            page = self.call(operation, request)
            yield page
            if _is_last(page):
                return
            request["cursor"] = page["next_cursor"]

    def wait_for_action(self, action_id: str, interval: float = 1.0) -> ActionReceipt:
        """Polls the receipt until terminal; ``unknown`` means submitted but unreconciled."""
        while True:
            receipt = self.actions.get_action({"action_id": action_id})
            if receipt["state"] in TERMINAL_ACTION_STATES:
                return receipt
            time.sleep(interval)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Client:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class AsyncClient:
    """Asyncio client; cancel the awaiting task to abort a request."""

    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        *,
        max_attempts: int = 3,
        retry_delay_ms: int = 200,
        timeout: float = 30.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._http = httpx.AsyncClient(base_url=base_url, headers=_headers(token), timeout=timeout, transport=transport)
        self._max_attempts = max_attempts
        self._retry_delay_ms = retry_delay_ms
        self.__dict__.update(_groups(self.call))

    async def call(self, operation: str, input: Mapping[str, Any]) -> Any:
        op, path, params, body = _request(operation, input)
        for attempt in range(1, self._max_attempts + 1):
            try:
                return _parse(await self._http.request(op.method, path, params=params, json=body))
            except (httpx.TransportError, SanctumError) as error:
                delay = _retry_delay(error, _is_safe(op, input), attempt, self._max_attempts, self._retry_delay_ms)
                if delay is None:
                    raise
                await asyncio.sleep(delay)
        raise AssertionError("unreachable")

    async def pages(self, operation: str, input: Mapping[str, Any]) -> AsyncIterator[dict[str, Any]]:
        request = dict(input)
        while True:
            page = await self.call(operation, request)
            yield page
            if _is_last(page):
                return
            request["cursor"] = page["next_cursor"]

    async def wait_for_action(self, action_id: str, interval: float = 1.0) -> ActionReceipt:
        while True:
            receipt = await self.actions.get_action({"action_id": action_id})
            if receipt["state"] in TERMINAL_ACTION_STATES:
                return receipt
            await asyncio.sleep(interval)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> AsyncClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()
