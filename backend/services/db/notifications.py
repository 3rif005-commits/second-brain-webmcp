"""`db_notifications` CRUD (Milestone 12, task-38) — the minimal in-app inbox migration
017's own header comment introduces: "both button actions and database automations have a
'Send notification to' action, and this app has genuinely nowhere for that to land ...
`db_notifications` is the minimal persisted inbox that makes the action mean something
real instead of a silent no-op — a row per notification, polled/fetched on load, not a
push channel."

Three functions, deliberately small (task-38-brief.md's "What to build": "new, small"):
`create_notification` (called by `services/db/automations.py`'s `send_notification`
action — Task 39's buttons will call it too), `list_notifications`, `mark_read`. No
bulk-mark-all-read endpoint (decision 11: "not required").
"""
from __future__ import annotations

import uuid as uuid_lib
from typing import Any

import asyncpg

from models.database import NotificationResponse


def _to_response(row: asyncpg.Record) -> NotificationResponse:
    return NotificationResponse(
        **{k: (str(v) if isinstance(v, uuid_lib.UUID) else v) for k, v in dict(row).items()}
    )


async def create_notification(
    conn: asyncpg.Connection,
    user_id: str,
    *,
    message: str,
    source: str | None = None,
    link: str | None = None,
) -> NotificationResponse:
    """Inserts one notification. `source` is free text (e.g. `"automation:<id>"`,
    Task 39's future `"button:<property_key>"`) — never validated against an FK,
    per migration 017's own "survives the thing that created it being edited or
    deleted" reasoning."""
    row = await conn.fetchrow(
        """
        INSERT INTO db_notifications (user_id, message, link, source)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        """,
        user_id,
        message,
        link,
        source,
    )
    return _to_response(row)


async def list_notifications(
    conn: asyncpg.Connection, user_id: str, *, unread_only: bool = False
) -> list[NotificationResponse]:
    """Most recent first (migration 017's `db_notifications_user_idx` is defined on
    exactly `(user_id, created_at DESC)` for this query). `unread_only` uses the
    partial `db_notifications_unread_idx` the same migration also defines."""
    if unread_only:
        rows = await conn.fetch(
            """
            SELECT * FROM db_notifications
            WHERE user_id = $1 AND read_at IS NULL
            ORDER BY created_at DESC
            """,
            user_id,
        )
    else:
        rows = await conn.fetch(
            """
            SELECT * FROM db_notifications WHERE user_id = $1 ORDER BY created_at DESC
            """,
            user_id,
        )
    return [_to_response(r) for r in rows]


async def mark_read(conn: asyncpg.Connection, user_id: str, notification_id: str) -> NotificationResponse | None:
    """Body-less "mark read" semantics (decision 11: "your call, keep it simple") --
    always sets `read_at = now()`, idempotently (re-marking an already-read
    notification is a no-op, not an error). Returns `None` for an unknown/foreign
    `notification_id`, the router's own 404 signal, matching `get_template`'s
    convention."""
    row = await conn.fetchrow(
        """
        UPDATE db_notifications SET read_at = COALESCE(read_at, now())
        WHERE id = $1 AND user_id = $2
        RETURNING *
        """,
        notification_id,
        user_id,
    )
    return _to_response(row) if row is not None else None
