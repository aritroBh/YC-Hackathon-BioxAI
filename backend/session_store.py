from __future__ import annotations

import json
from pathlib import Path
from threading import RLock
from typing import Optional
from uuid import uuid4

from models import Session

_SESSIONS: dict[str, Session] = {}
_LOCK = RLock()
_DEMO_SESSION_DIR = Path(__file__).resolve().parent / "demo_sessions"


def create_session(session_id: str | None = None) -> Session:
    created_session = Session(session_id=session_id or uuid4().hex)
    with _LOCK:
        _SESSIONS[created_session.session_id] = created_session
    return created_session


def get_session(session_id: str) -> Optional[Session]:
    with _LOCK:
        session = _SESSIONS.get(session_id)
    if session is not None:
        return session
    return load_session_from_disk(session_id)


def update_session(session_id: str, **changes) -> Optional[Session]:
    with _LOCK:
        session = _SESSIONS.get(session_id)
        if session is None:
            return None
        updated = session.model_copy(update=changes, deep=True)
        _SESSIONS[session_id] = updated
        return updated


def save_session_to_disk(session_id: str) -> None:
    with _LOCK:
        session = _SESSIONS.get(session_id)
        if session is None:
            return
        payload = session.model_dump_json(indent=2)

    _DEMO_SESSION_DIR.mkdir(parents=True, exist_ok=True)
    (_DEMO_SESSION_DIR / f"{session_id}.json").write_text(payload, encoding="utf-8")


def load_session_from_disk(session_id: str) -> Optional[Session]:
    path = _DEMO_SESSION_DIR / f"{session_id}.json"
    if not path.exists():
        return None

    data = json.loads(path.read_text(encoding="utf-8-sig"))
    session = Session.model_validate(data)
    with _LOCK:
        _SESSIONS[session_id] = session
    return session
