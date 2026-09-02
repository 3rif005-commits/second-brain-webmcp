from datetime import datetime
from typing import Any, Literal
from pydantic import BaseModel


class NoteBase(BaseModel):
    title: str = "Untitled"
    content: list[Any] = []
    content_text: str | None = None
    collection_id: str | None = None
    source_type: Literal["manual", "pdf", "video", "audio", "url", "text"] | None = None
    source_url: str | None = None
    source_filename: str | None = None
    topics: list[str] = []
    mastery_status: Literal["not_started", "learning", "reviewing", "mastered"] = "not_started"


class NoteCreate(NoteBase):
    pass


class NoteUpdate(BaseModel):
    title: str | None = None
    icon: str | None = None
    is_favorited: bool | None = None
    last_viewed_at: datetime | None = None
    content: list[Any] | None = None
    content_text: str | None = None
    collection_id: str | None = None
    topics: list[str] | None = None
    mastery_status: Literal["not_started", "learning", "reviewing", "mastered"] | None = None
    is_indexed: bool | None = None


class NoteResponse(NoteBase):
    id: str
    user_id: str
    icon: str = "📄"
    is_favorited: bool = False
    last_viewed_at: datetime | None = None
    is_indexed: bool
    deleted_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
