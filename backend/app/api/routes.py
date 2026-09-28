from __future__ import annotations

import asyncio
import json
import tempfile
from collections import defaultdict
from datetime import UTC, datetime
from importlib.metadata import version as package_version
from pathlib import Path
from typing import Any, cast

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import TypeAdapter
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.adapters.base import AdapterError
from backend.app.adapters.pi import (
    get_pi_catalog,
    list_pi_credentials,
    pi_credential_reference,
    validate_parameters,
)
from backend.app.api.schemas import (
    ModelProfileCreate,
    ModelProfileOut,
    ModelProfilePatch,
    PiCatalogOut,
    PiCredentialsOut,
    PublicationExportRequest,
    RunCreate,
    RunCreated,
)
from backend.app.config import settings
from backend.app.db import SessionLocal, get_session
from backend.app.domain import (
    AstRule,
    BenchmarkCaseDefinition,
    ComparisonConfig,
    SemanticLayer,
    StructureSnapshot,
)
from backend.app.middleware import bootstrap_payload
from backend.app.models import (
    BenchmarkCase,
    BenchmarkSuite,
    CaseRun,
    ComparisonRun,
    ModelProfile,
    ModelRun,
    RunEvent,
    SuiteVersion,
)
from backend.app.services.benchmark_engine import benchmark_engine
from backend.app.services.events import event_hub, event_writer
from backend.app.services.evidence import (
    build_publication_preview,
    export_run_evidence_zip,
)
from backend.app.services.profiles import (
    check_profile,
    health_is_current,
    profile_public,
)
from backend.app.services.reporting import (
    EvidenceLookupError,
    build_case_evidence,
    build_run_report,
    build_run_snapshot,
)
from backend.app.services.suites import build_generation_request
from backend.app.services.workflows import TERMINAL_RUN_STATUSES, failed_case_keys, preflight_run

router = APIRouter(prefix="/api")
TERMINAL_EVENTS = {"run.completed", "run.cancelled", "run.interrupted"}


def fail(status: int, code: str, message: str, details: Any = None) -> HTTPException:
    return HTTPException(
        status_code=status,
        detail={"code": code, "message": message, "details": details or {}},
    )


@router.get("/bootstrap")
async def bootstrap(response: Response) -> dict[str, Any]:
    return {
        **bootstrap_payload(response),
        "app_version": settings.app_version,
        "scorer_version": settings.scorer_version,
    }


@router.get("/pi/credentials", response_model=PiCredentialsOut)
async def pi_credentials() -> dict[str, Any]:
    return await list_pi_credentials()


@router.get("/pi/catalog", response_model=PiCatalogOut, response_model_exclude_none=True)
async def pi_catalog() -> dict[str, Any]:
    try:
        return await get_pi_catalog()
    except AdapterError as exc:
        raise fail(503, exc.code, str(exc), exc.details) from exc


@router.get("/model-profiles", response_model=list[ModelProfileOut])
async def list_model_profiles(session: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    profiles = list(
        (
            await session.scalars(
                select(ModelProfile)
                .where(ModelProfile.deleted_at.is_(None))
                .order_by(ModelProfile.created_at)
            )
        ).all()
    )
    return [profile_public(profile) for profile in profiles]


@router.post("/model-profiles", response_model=ModelProfileOut)
async def create_model_profile(
    payload: ModelProfileCreate,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    try:
        parameters = validate_parameters(
            payload.parameters, payload.base_url, payload.response_mode, payload.model_id
        )
    except ValueError as exc:
        raise fail(422, "invalid_pi_parameters", str(exc)) from exc
    if parameters["auth_mode"] == "oauth" and payload.pricing is not None:
        raise fail(422, "invalid_pi_parameters", "订阅 OAuth 不按 API Token 单价估算账单")
    reference: str | None
    try:
        reference = await pi_credential_reference(
            parameters["provider"], payload.model_id, payload.base_url, parameters["auth_mode"]
        )
    except AdapterError as exc:
        raise fail(422, exc.code, str(exc), exc.details) from exc
    profile = ModelProfile(
        name=payload.name,
        adapter_kind=payload.adapter_kind,
        model_id=payload.model_id,
        base_url=payload.base_url,
        response_mode=payload.response_mode,
        api_key_ref=reference,
        parameters_json=parameters,
        pricing_json=payload.pricing.model_dump(mode="json") if payload.pricing else None,
        enabled=payload.enabled,
    )
    session.add(profile)
    await session.commit()
    await session.refresh(profile)
    return profile_public(profile)


@router.patch("/model-profiles/{profile_id}", response_model=ModelProfileOut)
async def patch_model_profile(
    profile_id: int,
    payload: ModelProfilePatch,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    profile = await session.get(ModelProfile, profile_id)
    if profile is None or profile.deleted_at is not None:
        raise fail(404, "profile_not_found", "模型配置不存在")
    structural_fields = {
        "model_id",
        "base_url",
        "response_mode",
        "parameters",
        "pricing",
    }
    if profile.adapter_kind != "pi" and payload.model_fields_set & structural_fields:
        raise fail(
            409,
            "legacy_profile_migration_required",
            "历史适配器配置不可修改；请新建 Pi 模型配置（仍可禁用或删除此配置）",
        )
    if profile.adapter_kind != "pi":
        for key, value in payload.model_dump(exclude_unset=True).items():
            setattr(profile, key, value)
        await session.commit()
        await session.refresh(profile)
        return profile_public(profile)
    candidate_base_url = (
        payload.base_url if "base_url" in payload.model_fields_set else profile.base_url
    )
    candidate_response_mode = (
        payload.response_mode
        if "response_mode" in payload.model_fields_set
        else profile.response_mode
    )
    candidate_model_id = (
        payload.model_id if "model_id" in payload.model_fields_set else profile.model_id
    )
    candidate_parameters = (
        payload.parameters if "parameters" in payload.model_fields_set else profile.parameters_json
    )
    if (
        candidate_parameters is None
        or candidate_response_mode is None
        or candidate_model_id is None
    ):
        raise fail(
            422, "invalid_pi_parameters", "parameters、response_mode 与 model_id 不能为 null"
        )
    try:
        normalized_parameters = validate_parameters(
            candidate_parameters,
            candidate_base_url,
            candidate_response_mode,
            candidate_model_id,
        )
    except ValueError as exc:
        raise fail(422, "invalid_pi_parameters", str(exc)) from exc
    candidate_pricing = (
        payload.pricing if "pricing" in payload.model_fields_set else profile.pricing_json
    )
    if normalized_parameters["auth_mode"] == "oauth" and candidate_pricing is not None:
        raise fail(422, "invalid_pi_parameters", "订阅 OAuth 不按 API Token 单价估算账单")
    updates = payload.model_dump(exclude_unset=True)
    if "parameters" in updates:
        updates["parameters_json"] = normalized_parameters
        updates.pop("parameters")
    if "pricing" in updates:
        updates["pricing_json"] = updates.pop("pricing")
    for key, value in updates.items():
        setattr(profile, key, value)
    if {"parameters", "model_id", "base_url"} & payload.model_fields_set:
        try:
            profile.api_key_ref = await pi_credential_reference(
                normalized_parameters["provider"],
                candidate_model_id,
                candidate_base_url,
                normalized_parameters["auth_mode"],
            )
        except AdapterError as exc:
            raise fail(422, exc.code, str(exc), exc.details) from exc
    profile.health_status = "unknown"
    profile.health_details_json = {}
    profile.health_expires_at = None
    await session.commit()
    await session.refresh(profile)
    return profile_public(profile)


@router.delete("/model-profiles/{profile_id}")
async def delete_model_profile(
    profile_id: int,
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    profile = await session.get(ModelProfile, profile_id)
    if profile is None or profile.deleted_at is not None:
        raise fail(404, "profile_not_found", "模型配置不存在")
    profile.deleted_at = datetime.now(UTC)
    profile.enabled = False
    await session.commit()
    return {"status": "deleted"}


@router.post("/model-profiles/{profile_id}/check", response_model=ModelProfileOut)
async def check_model_profile(
    profile_id: int,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    profile = await session.get(ModelProfile, profile_id)
    if profile is None or profile.deleted_at is not None:
        raise fail(404, "profile_not_found", "模型配置不存在")
    await check_profile(profile)
    await session.commit()
    await session.refresh(profile)
    return profile_public(profile)


def case_to_dict(case: BenchmarkCase, include_reference: bool) -> dict[str, Any]:
    result = {
        "id": case.id,
        "stable_key": case.stable_key,
        "title": case.title,
        "category": case.category,
        "radar_dimension": case.radar_dimension,
        "difficulty": case.difficulty,
        "question": case.question,
        "required_ast": case.required_ast_json,
        "comparison": case.comparison_json,
        "weight": case.weight,
        "sort_order": case.sort_order,
    }
    if include_reference:
        result["reference_sql"] = case.reference_sql
    return result


@router.get("/suites")
async def list_suites(session: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    suites = list(
        (
            await session.scalars(
                select(BenchmarkSuite)
                .options(selectinload(BenchmarkSuite.versions).selectinload(SuiteVersion.cases))
                .order_by(BenchmarkSuite.created_at)
            )
        ).all()
    )
    result: list[dict[str, Any]] = []
    for suite in suites:
        published_versions = [
            {
                "id": version.id,
                "version": version.version,
                "status": version.status,
                "dialect": version.dialect,
                "content_hash": version.content_hash,
                "published_at": version.published_at,
                "schema_sql": version.schema_sql,
                "seed_sql": version.seed_sql,
                "semantic": version.semantic_layer_json,
                "prompt_template": version.prompt_template,
                "structure": version.structure_snapshot_json,
                "cases": [
                    case_to_dict(case, include_reference=True)
                    for case in sorted(version.cases, key=lambda item: item.sort_order)
                ],
            }
            for version in sorted(suite.versions, key=lambda item: item.version)
            if version.status == "published"
        ]
        if published_versions:
            result.append(
                {
                    "id": suite.id,
                    "name": suite.name,
                    "description": suite.description,
                    "versions": published_versions,
                }
            )
    return result


@router.get("/suite-versions/{version_id}/prompt-preview")
async def prompt_preview(
    version_id: int,
    case_id: int,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    row = (
        await session.execute(
            select(SuiteVersion, BenchmarkCase)
            .join(BenchmarkCase, BenchmarkCase.suite_version_id == SuiteVersion.id)
            .where(
                SuiteVersion.id == version_id,
                SuiteVersion.status == "published",
                BenchmarkCase.id == case_id,
            )
        )
    ).one_or_none()
    if row is None:
        raise fail(404, "suite_case_not_found", "测试集版本或题目不存在")
    version, case = row
    if not version.structure_snapshot_json:
        raise fail(409, "structure_not_available", "测试集尚未生成结构快照")
    definition = BenchmarkCaseDefinition(
        stable_key=case.stable_key,
        title=case.title,
        category=case.category,
        radar_dimension=case.radar_dimension,
        difficulty=case.difficulty,
        question=case.question,
        reference_sql=case.reference_sql,
        required_ast=TypeAdapter(list[AstRule]).validate_python(case.required_ast_json),
        comparison=ComparisonConfig.model_validate(case.comparison_json),
        weight=case.weight,
        sort_order=case.sort_order,
    )
    request = build_generation_request(
        version.prompt_template,
        StructureSnapshot.model_validate(version.structure_snapshot_json),
        SemanticLayer.model_validate(version.semantic_layer_json),
        definition,
    )
    return {
        "case_id": case.id,
        "stable_key": case.stable_key,
        "prompt": request.prompt,
        "output_schema": request.output_schema,
    }




async def ensure_profile_healthy(profile: ModelProfile) -> None:
    if not health_is_current(profile):
        await check_profile(profile)
    if profile.health_status != "healthy":
        raise fail(
            422,
            "profile_not_healthy",
            f"模型 {profile.name} 当前不可运行",
            {"health_status": profile.health_status, "health_details": profile.health_details_json},
        )


async def create_run_record(
    payload: RunCreate,
    session: AsyncSession,
    source_run_id: int | None = None,
) -> ComparisonRun:
    version = await session.scalar(
        select(SuiteVersion)
        .options(selectinload(SuiteVersion.cases))
        .where(SuiteVersion.id == payload.suite_version_id)
    )
    if version is None or version.status != "published" or not version.content_hash:
        raise fail(422, "suite_not_published", "运行要求 published 测试集")
    profiles = list(
        (
            await session.scalars(
                select(ModelProfile).where(
                    ModelProfile.id.in_(payload.model_profile_ids),
                    ModelProfile.deleted_at.is_(None),
                    ModelProfile.enabled.is_(True),
                )
            )
        ).all()
    )
    profile_by_id = {profile.id: profile for profile in profiles}
    if set(profile_by_id) != set(payload.model_profile_ids):
        raise fail(422, "profile_unavailable", "存在禁用、删除或不存在的模型配置")
    legacy_profiles = [profile.name for profile in profiles if profile.adapter_kind != "pi"]
    if legacy_profiles:
        raise fail(
            422,
            "legacy_profile_migration_required",
            "历史适配器配置不可运行；请新建 Pi 模型配置",
            {"profiles": legacy_profiles},
        )
    for profile_id in payload.model_profile_ids:
        await ensure_profile_healthy(profile_by_id[profile_id])
    cases = sorted(version.cases, key=lambda item: item.sort_order)
    if payload.case_ids is not None:
        selected = set(payload.case_ids)
        cases = [case for case in cases if case.id in selected]
        if {case.id for case in cases} != selected:
            raise fail(422, "case_not_in_suite", "存在不属于测试集版本的 case")
    if not cases:
        raise fail(422, "case_selection_empty", "至少选择一道题")
    run = ComparisonRun(
        source_run_id=source_run_id,
        suite_version_id=version.id,
        suite_content_hash=version.content_hash,
        selected_case_keys_json=[case.stable_key for case in cases],
        status="queued",
        attempts=payload.attempts,
        app_version_snapshot=settings.app_version,
        scorer_version_snapshot=settings.scorer_version,
        duckdb_version_snapshot=__import__("duckdb").__version__,
        sqlglot_version_snapshot=package_version("sqlglot"),
        output_contract_snapshot="query-plan-v1",
    )
    session.add(run)
    await session.flush()
    for order, profile_id in enumerate(payload.model_profile_ids):
        profile = profile_by_id[profile_id]
        model = ModelRun(
            comparison_run_id=run.id,
            model_profile_id=profile.id,
            selection_order=order,
            profile_name_snapshot=profile.name,
            adapter_kind_snapshot=profile.adapter_kind,
            base_url_snapshot=profile.base_url,
            response_mode_snapshot=profile.response_mode,
            requested_model_id=profile.model_id,
            resolved_model_id=profile.health_details_json.get("resolved_model_id"),
            parameters_snapshot_json=profile.parameters_json,
            pricing_snapshot_json=profile.pricing_json,
            api_key_ref_snapshot=profile.api_key_ref,
            cli_version_snapshot=profile.health_details_json.get("version"),
            isolation_snapshot_json=profile.health_details_json,
            status="queued",
        )
        session.add(model)
        await session.flush()
        session.add_all(
            [
                CaseRun(
                    model_run_id=model.id,
                    benchmark_case_id=case.id,
                    stable_case_key_snapshot=case.stable_key,
                    attempt=attempt,
                    status="queued",
                )
                for case in cases
                for attempt in range(1, payload.attempts + 1)
            ]
        )
    await session.flush()
    return run


@router.get("/runs")
async def list_runs(
    limit: int = Query(default=20, ge=1, le=100),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    runs = list(
        (
            await session.scalars(
                select(ComparisonRun).order_by(ComparisonRun.created_at.desc()).limit(limit)
            )
        ).all()
    )
    run_ids = [run.id for run in runs]
    models_by_run: defaultdict[int, list[dict[str, Any]]] = defaultdict(list)
    if run_ids:
        rows = (
            await session.execute(
                select(ModelRun, ModelProfile)
                .outerjoin(ModelProfile, ModelProfile.id == ModelRun.model_profile_id)
                .where(ModelRun.comparison_run_id.in_(run_ids))
                .order_by(ModelRun.comparison_run_id, ModelRun.selection_order)
            )
        ).all()
        for model, profile in rows:
            models_by_run[model.comparison_run_id].append(
                {
                    "id": model.id,
                    "name": profile.name if profile else f"model-{model.model_profile_id}",
                    "requested_model_id": model.requested_model_id,
                    "status": model.status,
                    "official_score": model.official_score,
                }
            )
    return {
        "runs": [
            {
                "id": run.id,
                "source_run_id": run.source_run_id,
                "suite_version_id": run.suite_version_id,
                "suite_content_hash": run.suite_content_hash,
                "status": run.status,
                "attempts": run.attempts,
                "case_count": len(run.selected_case_keys_json),
                "created_at": run.created_at,
                "started_at": run.started_at,
                "finished_at": run.finished_at,
                "models": models_by_run[run.id],
            }
            for run in runs
        ]
    }


@router.post("/runs/preflight")
async def preflight(
    payload: RunCreate,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await preflight_run(session, payload)


@router.post("/runs", response_model=RunCreated)
async def create_run(
    payload: RunCreate,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    run = await create_run_record(payload, session)
    await session.commit()
    await event_writer.emit(run.id, "run.created", "info", {"status": "queued"})
    benchmark_engine.launch(run.id)
    return {
        "id": run.id,
        "mode": "single" if len(payload.model_profile_ids) == 1 else "comparison",
        "status": "queued",
    }


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: int) -> dict[str, str]:
    try:
        status = await benchmark_engine.cancel(run_id)
    except LookupError as exc:
        raise fail(404, "run_not_found", "运行不存在") from exc
    return {"status": status}


@router.post("/runs/{run_id}/rerun", response_model=RunCreated)
async def rerun(
    run_id: int,
    mode: str = Query(default="exact", pattern="^(exact|current)$"),
    scope: str = Query(default="all", pattern="^(all|failed)$"),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    source = await session.get(ComparisonRun, run_id)
    if source is None:
        raise fail(404, "run_not_found", "运行不存在")
    if source.status not in TERMINAL_RUN_STATUSES:
        raise fail(409, "source_run_active", "运行进行中，不能补跑")
    selected_keys = list(source.selected_case_keys_json)
    if scope == "failed":
        selected_keys = await failed_case_keys(session, run_id)
        if not selected_keys:
            raise fail(409, "rerun_subset_empty", "没有失败或未完成的题目可补跑")
    source_models = list(
        (
            await session.scalars(
                select(ModelRun)
                .where(ModelRun.comparison_run_id == run_id)
                .order_by(ModelRun.selection_order)
            )
        ).all()
    )
    legacy_snapshots = [
        model.profile_name_snapshot
        for model in source_models
        if model.adapter_kind_snapshot != "pi"
    ]
    if legacy_snapshots:
        raise fail(
            422,
            "legacy_profile_migration_required",
            "历史适配器运行不可补跑；请使用 Pi 模型配置新建运行",
            {"profiles": legacy_snapshots},
        )
    cases = list(
        (
            await session.scalars(
                select(BenchmarkCase).where(
                    BenchmarkCase.suite_version_id == source.suite_version_id,
                    BenchmarkCase.stable_key.in_(selected_keys),
                )
            )
        ).all()
    )
    case_by_key = {case.stable_key: case for case in cases}
    ordered_cases = [case_by_key[key] for key in selected_keys]
    if mode == "current":
        payload = RunCreate(
            suite_version_id=source.suite_version_id,
            model_profile_ids=[model.model_profile_id for model in source_models],
            case_ids=[case.id for case in ordered_cases],
            attempts=source.attempts,
        )
        run = await create_run_record(payload, session, source_run_id=run_id)
    else:
        if (
            source.scorer_version_snapshot != settings.scorer_version
            or source.app_version_snapshot != settings.app_version
            or source.duckdb_version_snapshot != __import__("duckdb").__version__
            or source.sqlglot_version_snapshot != package_version("sqlglot")
        ):
            raise fail(
                409,
                "exact_environment_changed",
                "原运行的执行或评分版本已变化，不能冒充原样复测；请选择当前配置创建新运行",
            )
        run = ComparisonRun(
            source_run_id=run_id,
            suite_version_id=source.suite_version_id,
            suite_content_hash=source.suite_content_hash,
            selected_case_keys_json=list(selected_keys),
            status="queued",
            attempts=source.attempts,
            app_version_snapshot=source.app_version_snapshot,
            scorer_version_snapshot=source.scorer_version_snapshot,
            duckdb_version_snapshot=source.duckdb_version_snapshot,
            sqlglot_version_snapshot=source.sqlglot_version_snapshot,
            output_contract_snapshot=source.output_contract_snapshot,
        )
        session.add(run)
        await session.flush()
        for source_model in source_models:
            model = ModelRun(
                comparison_run_id=run.id,
                model_profile_id=source_model.model_profile_id,
                selection_order=source_model.selection_order,
                profile_name_snapshot=source_model.profile_name_snapshot,
                adapter_kind_snapshot=source_model.adapter_kind_snapshot,
                base_url_snapshot=source_model.base_url_snapshot,
                response_mode_snapshot=source_model.response_mode_snapshot,
                requested_model_id=source_model.requested_model_id,
                resolved_model_id=source_model.resolved_model_id,
                parameters_snapshot_json=source_model.parameters_snapshot_json,
                pricing_snapshot_json=source_model.pricing_snapshot_json,
                api_key_ref_snapshot=source_model.api_key_ref_snapshot,
                cli_version_snapshot=source_model.cli_version_snapshot,
                isolation_snapshot_json=source_model.isolation_snapshot_json,
                status="queued",
            )
            session.add(model)
            await session.flush()
            session.add_all(
                [
                    CaseRun(
                        model_run_id=model.id,
                        benchmark_case_id=case.id,
                        stable_case_key_snapshot=case.stable_key,
                        attempt=attempt,
                        status="queued",
                    )
                    for case in ordered_cases
                    for attempt in range(1, source.attempts + 1)
                ]
            )
    await session.commit()
    await event_writer.emit(
        run.id,
        "run.created",
        "info",
        {
            "status": "queued",
            "rerun_mode": mode,
            "rerun_scope": scope,
            "source_run_id": run_id,
        },
    )
    benchmark_engine.launch(run.id)
    return {
        "id": run.id,
        "mode": "single" if len(source_models) == 1 else "comparison",
        "status": "queued",
    }


async def run_snapshot(session: AsyncSession, run_id: int) -> dict[str, Any]:
    try:
        return await build_run_snapshot(session, run_id)
    except EvidenceLookupError as exc:
        raise fail(404, exc.code, str(exc)) from exc


@router.get("/runs/{run_id}")
async def get_run(
    run_id: int,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await run_snapshot(session, run_id)


@router.get("/runs/{run_id}/publication-preview")
async def publication_preview(
    run_id: int,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    try:
        preview = await build_publication_preview(session, run_id)
    except LookupError as exc:
        raise fail(404, "run_not_found", "运行不存在") from exc
    if not preview["eligible"]:
        raise fail(409, "run_not_terminal", "只有终态运行可以预览发布包")
    return preview


@router.post("/runs/{run_id}/publication-export")
async def publication_export(
    run_id: int,
    payload: PublicationExportRequest,
    session: AsyncSession = Depends(get_session),
) -> Response:
    try:
        preview = await build_publication_preview(session, run_id)
    except LookupError as exc:
        raise fail(404, "run_not_found", "运行不存在") from exc
    if not preview["eligible"]:
        raise fail(409, "run_not_terminal", "只有终态运行可以导出发布包")
    if preview["summary_digest"] != payload.preview_digest:
        raise fail(
            409,
            "publication_preview_changed",
            "发布预览已变化，请重新预览后确认",
            {"current_summary_digest": preview["summary_digest"]},
        )
    with tempfile.TemporaryDirectory(prefix="llm-test-publication-response-") as name:
        archive = Path(name) / f"run-{run_id:04d}-publication.zip"
        await export_run_evidence_zip(run_id, archive)
        content = archive.read_bytes()
    return Response(
        content=content,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="run-{run_id:04d}-publication.zip"',
            "Cache-Control": "no-store",
            "X-Publication-Status": "exported-not-published",
        },
    )


def sse_message(event: dict[str, Any]) -> str:
    data = json.dumps(event, ensure_ascii=False)
    return f"id: {event['seq']}\nevent: {event['event_type']}\ndata: {data}\n\n"


@router.get("/runs/{run_id}/events")
async def stream_events(
    run_id: int,
    request: Request,
    after_seq: int = Query(default=0, ge=0),
    last_event_id: int | None = Header(default=None, alias="Last-Event-ID"),
) -> StreamingResponse:
    resume_after = max(last_event_id or 0, after_seq)

    async def generate() -> Any:
        async with event_hub.subscribe(run_id, lambda: event_writer.watermark(run_id)) as (
            queue,
            watermark,
        ):
            async with SessionLocal() as session:
                backlog = list(
                    (
                        await session.scalars(
                            select(RunEvent)
                            .where(
                                RunEvent.comparison_run_id == run_id,
                                RunEvent.seq > resume_after,
                                RunEvent.seq <= watermark,
                            )
                            .order_by(RunEvent.seq)
                        )
                    ).all()
                )
            emitted: set[int] = set()
            for stored in backlog:
                event = {
                    "seq": stored.seq,
                    "event_type": stored.event_type,
                    "level": stored.level,
                    "created_at": stored.created_at.replace(tzinfo=UTC).isoformat(),
                    "model_run_id": stored.model_run_id,
                    "case_run_id": stored.case_run_id,
                    "message": stored.message,
                    "payload": stored.payload_json,
                }
                emitted.add(stored.seq)
                yield sse_message(event)
                if event["event_type"] in TERMINAL_EVENTS:
                    return
            while not await request.is_disconnected():
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if event["seq"] in emitted:
                    continue
                emitted.add(cast(int, event["seq"]))
                yield sse_message(event)
                if event["event_type"] in TERMINAL_EVENTS:
                    break

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.get("/runs/{run_id}/events/history")
async def event_history(
    run_id: int,
    model_run_ids: list[int] | None = Query(default=None),
    case_run_ids: list[int] | None = Query(default=None),
    levels: list[str] | None = Query(default=None),
    event_types: list[str] | None = Query(default=None),
    search: str | None = None,
    after_seq: int = Query(default=0, ge=0),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=500, ge=1, le=5000),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    conditions = [RunEvent.comparison_run_id == run_id]
    if after_seq:
        conditions.append(RunEvent.seq > after_seq)
    if model_run_ids:
        conditions.append(RunEvent.model_run_id.in_(model_run_ids))
    if case_run_ids:
        conditions.append(RunEvent.case_run_id.in_(case_run_ids))
    if levels:
        conditions.append(RunEvent.level.in_(levels))
    if event_types:
        conditions.append(RunEvent.event_type.in_(event_types))
    if search:
        conditions.append(
            or_(RunEvent.message.ilike(f"%{search}%"), RunEvent.event_type.ilike(f"%{search}%"))
        )
    total = await session.scalar(
        select(func.count()).select_from(RunEvent).where(and_(*conditions))
    )
    events = list(
        (
            await session.scalars(
                select(RunEvent)
                .where(and_(*conditions))
                .order_by(RunEvent.seq)
                .offset(offset)
                .limit(limit)
            )
        ).all()
    )
    return {
        "total": int(total or 0),
        "events": [
            {
                "seq": event.seq,
                "event_type": event.event_type,
                "level": event.level,
                "created_at": event.created_at.replace(tzinfo=UTC),
                "model_run_id": event.model_run_id,
                "case_run_id": event.case_run_id,
                "message": event.message,
                "payload": event.payload_json,
            }
            for event in events
        ],
    }


@router.get("/case-runs/{case_run_id}")
async def get_case_run(
    case_run_id: int,
    include_reference: bool = False,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    try:
        return await build_case_evidence(session, case_run_id, include_reference=include_reference)
    except EvidenceLookupError as exc:
        status = 404 if exc.code == "case_run_not_found" else 409
        raise fail(status, exc.code, str(exc)) from exc


@router.get("/runs/{run_id}/report")
async def run_report(
    run_id: int,
    session: AsyncSession = Depends(get_session),
) -> Response:
    report = build_run_report(await run_snapshot(session, run_id))
    return Response(
        content=json.dumps(report, ensure_ascii=False, default=str),
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )
