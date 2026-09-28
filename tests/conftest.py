from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest

TEST_VAR_DIR = Path(tempfile.mkdtemp(prefix="llm-test-pytest-"))
os.environ["LLM_TEST_VAR_DIR"] = str(TEST_VAR_DIR)
os.environ["LLM_TEST_DATABASE_URL"] = f"sqlite+aiosqlite:///{TEST_VAR_DIR / 'app.db'}"
# Credentials are read from the local Pi config: tests never touch the developer's home.
TEST_HOME = Path(tempfile.mkdtemp(prefix="llm-test-home-"))
os.environ["HOME"] = str(TEST_HOME)
_TEST_AGENT_DIR = TEST_HOME / ".pi" / "agent"
_TEST_AGENT_DIR.mkdir(parents=True)
(_TEST_AGENT_DIR / "auth.json").write_text(
    json.dumps({"openai": {"type": "api_key", "key": "baseline-pi-key"}})
)


@pytest.fixture
def pi_agent_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("HOME", str(tmp_path))
    directory = tmp_path / ".pi" / "agent"
    directory.mkdir(parents=True)
    return directory


@pytest.fixture(scope="session", autouse=True)
def isolated_database() -> Iterator[None]:
    from backend.app import models as _models  # noqa: F401
    from backend.app.db import Base, engine

    async def create() -> None:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(create())
    yield
    asyncio.run(engine.dispose())
    shutil.rmtree(TEST_VAR_DIR, ignore_errors=True)
    shutil.rmtree(TEST_HOME, ignore_errors=True)
