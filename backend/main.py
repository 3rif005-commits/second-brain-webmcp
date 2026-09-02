import logging
import sys
import time
import uuid
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from core.config import settings
from routers import notes, ingest, retrieval, internal, agent, agent_inline, agent_ingest, skills_api, mcp_api, note_sources, databases, db_import
from services.db.connection import close_pool
from services.db.scheduler import start_scheduler, stop_scheduler

# ── Logging ─────────────────────────────────────────────────────────────────
logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)-20s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Milestone 12 (task-37): the in-process job scheduler for repeating row
    # templates (and, from Task 38, database automations). Started
    # unconditionally, same posture as `databases.router` being included
    # unconditionally below regardless of `database_rows_enabled` — a tick
    # that can't reach the database (e.g. `DATABASE_URL` unset) logs and
    # retries next interval rather than failing startup; see
    # `services/db/scheduler.py`'s `_tick` docstring.
    start_scheduler()
    yield
    stop_scheduler()
    # Safe no-op if the database query engine's pool was never created
    # (database_rows_enabled defaults False, so this is normally the case).
    await close_pool()


app = FastAPI(title="Second Brain API", version="0.2.0", redirect_slashes=False, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(notes.router)
app.include_router(ingest.router)
app.include_router(retrieval.router)
app.include_router(agent.router)
app.include_router(agent_inline.router)
app.include_router(agent_ingest.router)
app.include_router(internal.router)
app.include_router(skills_api.router)
app.include_router(mcp_api.router)
app.include_router(note_sources.router)
app.include_router(databases.router)
app.include_router(db_import.router)


@app.middleware("http")
async def request_logger(request: Request, call_next):
    request_id = str(uuid.uuid4())[:8]
    request.state.request_id = request_id
    start = time.perf_counter()
    response = await call_next(request)
    ms = int((time.perf_counter() - start) * 1000)
    logging.getLogger("http").info(
        f"rid={request_id} | {request.method} {request.url.path} → {response.status_code} | {ms}ms"
    )
    return response


@app.get("/health")
async def health():
    return {"status": "ok"}
