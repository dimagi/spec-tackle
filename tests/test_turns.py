import asyncio

import pytest

from spec_tackle.turns import Busy, TurnRunner


def _work(gate: asyncio.Event, events):
    async def work(emit):
        emit(events[0])
        await gate.wait()
        for e in events[1:]:
            emit(e)
    return work


async def _drain(runner, thread_id):
    return [e async for e in runner.subscribe(thread_id)]


def test_late_subscriber_gets_earlier_events():
    async def go():
        runner, gate = TurnRunner(), asyncio.Event()
        runner.start(thread_id="t", work=_work(gate, [{"n": 1}, {"n": 2}, {"type": "done"}]))
        await asyncio.sleep(0)  # let the turn emit its first event
        first = asyncio.create_task(_drain(runner, "t"))
        second = asyncio.create_task(_drain(runner, "t"))
        await asyncio.sleep(0)
        gate.set()
        return await first, await second, runner.running("t")

    first, second, still_running = asyncio.run(go())
    assert first == second == [{"n": 1}, {"n": 2}, {"type": "done"}]
    assert still_running is False


def test_second_start_while_running_is_busy():
    async def go():
        runner, gate = TurnRunner(), asyncio.Event()
        runner.start(thread_id="t", work=_work(gate, [{}]))
        with pytest.raises(Busy):
            runner.start(thread_id="t", work=_work(gate, [{}]))
        gate.set()
        await runner.aclose()

    asyncio.run(go())


def test_subscribe_without_turn_yields_nothing():
    assert asyncio.run(_drain(TurnRunner(), "nope")) == []


def test_cancel_stops_the_turn_and_ends_subscriptions():
    async def go():
        runner, gate = TurnRunner(), asyncio.Event()
        runner.start(thread_id="t", work=_work(gate, [{"n": 1}, {"n": 2}]))
        await asyncio.sleep(0)
        sub = asyncio.create_task(_drain(runner, "t"))
        await asyncio.sleep(0)
        runner.cancel("t")
        events = await asyncio.wait_for(sub, 1)
        return events, runner.running("t")

    events, running = asyncio.run(go())
    assert events == [{"n": 1}] and running is False


def test_cancel_in_same_tick_cleans_up():
    async def go():
        runner, gate = TurnRunner(), asyncio.Event()
        runner.start(thread_id="t", work=_work(gate, [{"n": 1}]))
        runner.cancel("t")
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        still_running = runner.running("t")
        runner.start(thread_id="t", work=_work(gate, [{"n": 2}]))
        return still_running

    still_running = asyncio.run(go())
    assert still_running is False


def test_work_exception_cleans_up():
    async def go():
        async def failing_work(emit):
            emit({"n": 1})
            raise ValueError("boom")

        runner = TurnRunner()
        runner.start(thread_id="t", work=failing_work)
        await asyncio.sleep(0)
        sub = asyncio.create_task(_drain(runner, "t"))
        await asyncio.sleep(0)
        events = await asyncio.wait_for(sub, 1)
        return events, runner.running("t")

    events, running = asyncio.run(go())
    assert events == [{"n": 1}] and running is False
