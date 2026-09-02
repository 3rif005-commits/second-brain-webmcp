#!/usr/bin/env python3
"""Seed the demo account with a Reading List database.

Goes through the real HTTP API rather than writing SQL: a row is a note plus
a db_row_props companion, properties carry server-minted option ids, and a
seed that guessed at any of that would drift from the app the moment the
schema moved. Every call below is one the UI itself makes.

Usage:
  SUPABASE_URL=https://xxx.supabase.co \
  SUPABASE_ANON_KEY=... \
  DEMO_EMAIL=demo@example.com \
  DEMO_PASSWORD=... \
  API_URL=https://second-brain-api.onrender.com \
  python3 scripts/seed-demo.py
"""
from __future__ import annotations

import json
import os
import random
import string
import sys
import urllib.error
import urllib.request

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
EMAIL = os.environ.get("DEMO_EMAIL", "")
PASSWORD = os.environ.get("DEMO_PASSWORD", "")
API_URL = os.environ.get("API_URL", "http://localhost:8000").rstrip("/")

for name, value in [
    ("SUPABASE_URL", SUPABASE_URL),
    ("SUPABASE_ANON_KEY", ANON_KEY),
    ("DEMO_EMAIL", EMAIL),
    ("DEMO_PASSWORD", PASSWORD),
]:
    if not value:
        sys.exit(f"{name} is required")

_ALPHABET = string.ascii_letters + string.digits


def mint_key() -> str:
    """Same shape as services/db/keys.py: 8 chars of base62."""
    return "".join(random.choice(_ALPHABET) for _ in range(8))


def request(method: str, url: str, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as err:
        detail = err.read().decode()[:400]
        sys.exit(f"{method} {url} → {err.code}\n{detail}")


print("signing in…")
auth = request(
    "POST",
    f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
    {"email": EMAIL, "password": PASSWORD},
    {"apikey": ANON_KEY},
)
TOKEN = {"Authorization": f"Bearer {auth['access_token']}"}


def api(method: str, path: str, body=None):
    return request(method, f"{API_URL}/db{path}", body, TOKEN)


# ── Properties ───────────────────────────────────────────────────────────
# Option ids are minted here because PropertyCreate takes `config` verbatim.

STATUS_OPTIONS = [
    {"id": mint_key(), "name": n, "color": c, "group": g}
    for n, c, g in [
        ("To read", "gray", "To-do"),
        ("Reading", "blue", "In progress"),
        ("Done", "green", "Complete"),
        ("Abandoned", "red", "Complete"),
    ]
]
TOPIC_OPTIONS = [
    {"id": mint_key(), "name": n, "color": c}
    for n, c in [
        ("Agents", "purple"), ("Retrieval", "blue"), ("Interfaces", "orange"),
        ("Systems", "brown"), ("Protocols", "green"),
    ]
]

print("creating the database…")
detail = api("POST", "/databases", {"title": "Reading List", "icon": "📚"})
ds_id = detail["data_source"]["id"]
db_id = detail["database"]["id"]
title_prop = detail["properties"][0]["key"]

print("adding properties…")
props = {"Title": title_prop}
for spec in [
    {"name": "Status", "type": "status", "config": {"options": STATUS_OPTIONS}},
    {"name": "Rating", "type": "number", "config": {},
     "description": "1-5, how much it was worth the time"},
    {"name": "Topics", "type": "multi_select", "config": {"options": TOPIC_OPTIONS}},
    {"name": "Added", "type": "date", "config": {}},
    {"name": "Link", "type": "url", "config": {}},
]:
    created = api("POST", f"/data-sources/{ds_id}/properties", spec)
    props[spec["name"]] = created["key"]

print("adding views…")
for view in [
    {"name": "Board", "type": "board", "icon": None},
    {"name": "Gallery", "type": "gallery", "icon": None},
]:
    api("POST", f"/data-sources/{ds_id}/views", view)

# ── Rows ─────────────────────────────────────────────────────────────────
# Deliberately mixed: several Done, several Reading, several To read, so
# "group by Status" and "show only what I'm reading" both visibly change the
# grid rather than being no-ops.
ROWS = [
    ("Attention Is All You Need", "Done", 5, ["Systems"], "2026-07-02",
     "https://arxiv.org/abs/1706.03762"),
    ("The WebMCP explainer", "Reading", 5, ["Protocols", "Agents"], "2026-08-28",
     "https://github.com/webmachinelearning/webmcp"),
    ("Designing Data-Intensive Applications, ch. 5", "Reading", 4, ["Systems"],
     "2026-08-19", None),
    ("Retrieval-Augmented Generation", "Done", 4, ["Retrieval"], "2026-06-14",
     "https://arxiv.org/abs/2005.11401"),
    ("The Humane Interface", "To read", None, ["Interfaces"], "2026-08-30", None),
    ("Model Context Protocol specification", "Done", 5, ["Protocols"], "2026-05-11",
     "https://modelcontextprotocol.io"),
    ("A Philosophy of Software Design", "Reading", 5, ["Systems"], "2026-08-08", None),
    ("Direct Manipulation Interfaces (Hutchins)", "To read", None, ["Interfaces"],
     "2026-08-31", None),
    ("HNSW: efficient ANN search", "Done", 4, ["Retrieval"], "2026-06-30",
     "https://arxiv.org/abs/1603.09320"),
    ("Notion's data model, reverse-engineered", "To read", None, ["Systems"],
     "2026-09-01", None),
    ("CRDTs for collaborative editing", "Reading", 4, ["Systems", "Interfaces"],
     "2026-08-22", None),
    ("The Mother of All Demos (1968)", "Abandoned", 3, ["Interfaces"], "2026-04-02",
     None),
]

print(f"adding {len(ROWS)} rows…")
for title, status, rating, topics, added, link in ROWS:
    row = api("POST", f"/data-sources/{ds_id}/rows")
    values = [
        (props["Title"], {"type": "title", "title": title}),
        (props["Status"], {"type": "status", "status": status}),
        (props["Topics"], {"type": "multi_select", "multi_select": topics}),
        (props["Added"], {"type": "date",
                          "date": {"start": added, "end": None, "time_zone": None}}),
    ]
    if rating is not None:
        values.append((props["Rating"], {"type": "number", "number": rating}))
    if link is not None:
        values.append((props["Link"], {"type": "url", "url": link}))

    for key, value in values:
        api("PATCH", f"/data-sources/{ds_id}/rows/{row['id']}",
            {"property_key": key, "value": value})
    print(f"  · {title}")

print()
print("done.")
print(f"  database: {API_URL.replace('/db', '')} → /brain/db/{db_id}")
