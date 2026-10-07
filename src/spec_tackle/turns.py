"""Claude turns run as background tasks so a reload or a second tab can rejoin them.

FastAPI cancels a streaming response when the browser goes away; running the turn in
its own task keeps it going, and the event list lets late subscribers catch up.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field

Emit = Callable[[dict], None]


class Busy(Exception):
    pass


@dataclass
class _Turn:
    events: list[dict] = field(default_factory=list)
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    task: asyncio.Task | None = None


class TurnRunner:
    def __init__(self) -> None:
        self._turns: dict[str, _Turn] = {}

    def running(self, thread_id: str) -> bool:
        turn = self._turns.get(thread_id)
        return turn is not None and not turn.task.done()

    def start(self, *, thread_id: str, work: Callable[[Emit], Awaitable[None]]) -> None:
        turn = self._turns.get(thread_id)
        if turn is not None and not turn.task.done():
            raise Busy(thread_id)
        turn = _Turn()

        def emit(event: dict) -> None:
            turn.events.append(event)
            for queue in turn.subscribers:
                queue.put_nowait(event)

        def cleanup(task: asyncio.Task) -> None:
            for queue in turn.subscribers:
                queue.put_nowait(None)
            try:
                task.result()
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                logging.getLogger(__name__).error("Turn failed", exc_info=exc)

        self._turns[thread_id] = turn
        turn.task = asyncio.create_task(work(emit))
        turn.task.add_done_callback(cleanup)

    async def subscribe(self, thread_id: str) -> AsyncIterator[dict]:
        turn = self._turns.get(thread_id)
        if turn is None:
            return
        queue: asyncio.Queue = asyncio.Queue()
        for event in turn.events:
            queue.put_nowait(event)
        turn.subscribers.add(queue)
        if turn.task.done():
            queue.put_nowait(None)
        try:
            while (event := await queue.get()) is not None:
                yield event
        finally:
            turn.subscribers.discard(queue)

    def cancel(self, thread_id: str) -> None:
        turn = self._turns.get(thread_id)
        if turn and turn.task:
            turn.task.cancel()

    async def aclose(self) -> None:
        tasks = [t.task for t in self._turns.values() if t.task]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
