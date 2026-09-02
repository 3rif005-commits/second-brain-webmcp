"""Pydantic models for the agent stream wire format and tool plumbing."""
from enum import Enum
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field, TypeAdapter


class Tier(str, Enum):
    EXTERNAL = "external"
    INTERNAL_API = "internal_api"
    INTERNAL_LOCAL = "internal_local"


class Mode(str, Enum):
    LOCAL = "local"
    API = "api"


# --- Stream event types ---


class TextEvent(BaseModel):
    type: Literal["text"] = "text"
    content: str


class ToolCallEvent(BaseModel):
    type: Literal["tool_call"] = "tool_call"
    id: str
    tool: str
    args: dict[str, Any]


class ToolResultEvent(BaseModel):
    type: Literal["tool_result"] = "tool_result"
    id: str
    summary: str
    data: dict[str, Any] | None = None


class ToolDeniedEvent(BaseModel):
    type: Literal["tool_denied"] = "tool_denied"
    id: str
    tool: str
    reason: str


class SkillActiveEvent(BaseModel):
    type: Literal["skill_active"] = "skill_active"
    name: str


class ContextEvent(BaseModel):
    type: Literal["context"] = "context"
    notes: list[dict[str, Any]]


class DoneEvent(BaseModel):
    type: Literal["done"] = "done"
    thread_id: str
    message_id: str


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    content: str


class IngestCreatedEvent(BaseModel):
    type: Literal["ingest_created"] = "ingest_created"
    note_id: str


StreamEventType = Union[
    TextEvent,
    ToolCallEvent,
    ToolResultEvent,
    ToolDeniedEvent,
    SkillActiveEvent,
    ContextEvent,
    IngestCreatedEvent,
    DoneEvent,
    ErrorEvent,
]

StreamEvent = TypeAdapter(
    Annotated[StreamEventType, Field(discriminator="type")]
)


# --- Request models ---


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class AgentRequest(BaseModel):
    thread_id: str | None = None        # None = create new thread
    messages: list[ChatMessage]
    query: str                          # latest user message text
    mode: Mode = Mode.API
    current_note_id: str | None = None  # set when invoked from inline /ai
    surface: Literal["chat", "inline", "ingest", "interactive"] = "chat"
