from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.app.api.routes import router
from backend.app.bootstrap import bootstrap_builtin
from backend.app.config import settings
from backend.app.db import ensure_schema, recover_interrupted_runs
from backend.app.middleware import BrowserSafetyMiddleware
from backend.app.security import redact_secrets


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings.var_dir.mkdir(parents=True, exist_ok=True)
    (settings.var_dir / "suites").mkdir(parents=True, exist_ok=True)
    await ensure_schema()
    await bootstrap_builtin()
    await recover_interrupted_runs()
    yield


app = FastAPI(title="LLM Text-to-SQL Benchmark", version=settings.app_version, lifespan=lifespan)
app.add_middleware(BrowserSafetyMiddleware)
app.include_router(router)


def request_id(request: Request) -> str:
    return str(getattr(request.state, "request_id", "unknown"))


@app.exception_handler(HTTPException)
async def handle_http_error(request: Request, error: HTTPException) -> JSONResponse:
    detail: dict[str, Any] = error.detail if isinstance(error.detail, dict) else {}
    return JSONResponse(
        status_code=error.status_code,
        content={
            "code": detail.get("code", "http_error"),
            "message": detail.get("message", str(error.detail)),
            "details": redact_secrets(detail.get("details", {})),
            "request_id": request_id(request),
        },
    )


@app.exception_handler(RequestValidationError)
async def handle_validation_error(request: Request, error: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "code": "request_validation_error",
            "message": "请求参数不符合契约",
            "details": redact_secrets(json.loads(json.dumps(error.errors(), default=str))),
            "request_id": request_id(request),
        },
    )


@app.exception_handler(Exception)
async def handle_unexpected_error(request: Request, error: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={
            "code": "internal_error",
            "message": "内部错误",
            "details": {"error": str(redact_secrets(str(error)))},
            "request_id": request_id(request),
        },
    )


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": settings.app_version}


if settings.static_dir.exists():
    assets_dir = settings.static_dir / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa_fallback(path: str) -> FileResponse:
        requested = settings.static_dir / path
        if path and requested.is_file() and requested.is_relative_to(settings.static_dir):
            headers = {"Cache-Control": "no-cache"} if requested.suffix == ".html" else None
            return FileResponse(requested, headers=headers)
        return FileResponse(
            settings.static_dir / "index.html", headers={"Cache-Control": "no-cache"}
        )
