"""services/db/scheduler.py's `_tick()` (combined M12 review's Finding 3,
controller-added): the templates and automations passes must be isolated
from each other -- one raising must not prevent the other from running in
the same tick.
"""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.db import scheduler


def _fake_pool() -> MagicMock:
    pool = MagicMock()
    acquire_cm = MagicMock()
    acquire_cm.__aenter__ = AsyncMock(return_value="fake-conn")
    acquire_cm.__aexit__ = AsyncMock(return_value=False)
    pool.acquire.return_value = acquire_cm
    return pool


@pytest.mark.asyncio
async def test_tick_runs_automations_pass_even_if_templates_pass_raises():
    fake_pool = _fake_pool()

    with (
        patch.object(scheduler, "get_pool", AsyncMock(return_value=fake_pool)),
        patch.object(scheduler, "_tick_templates", AsyncMock(side_effect=RuntimeError("boom"))) as templates_mock,
        patch(
            "services.db.automations._tick_automations", AsyncMock()
        ) as automations_mock,
    ):
        await scheduler._tick()

    templates_mock.assert_awaited_once_with("fake-conn")
    automations_mock.assert_awaited_once_with("fake-conn")


@pytest.mark.asyncio
async def test_tick_runs_templates_pass_even_if_automations_pass_raises():
    fake_pool = _fake_pool()

    with (
        patch.object(scheduler, "get_pool", AsyncMock(return_value=fake_pool)),
        patch.object(scheduler, "_tick_templates", AsyncMock()) as templates_mock,
        patch(
            "services.db.automations._tick_automations",
            AsyncMock(side_effect=RuntimeError("boom")),
        ) as automations_mock,
    ):
        await scheduler._tick()

    templates_mock.assert_awaited_once_with("fake-conn")
    automations_mock.assert_awaited_once_with("fake-conn")
