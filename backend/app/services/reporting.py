from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import sqlglot
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlglot.errors import ParseError

from backend.app.config import settings
from backend.app.models import (
    BenchmarkCase,
    CaseRun,
    ComparisonRun,
    ModelProfile,
    ModelRun,
    RunEvent,
)
from backend.app.services.efficiency import aggregate_efficiency, case_efficiency
from backend.app.services.quality import (
    QUALITY_SCHEMA_VERSION,
    aggregate_result_quality,
    case_result_quality,
)
from backend.app.services.sql_evaluator import (
    attempt_statistics,
    build_conclusion,
    weighted_average,
)


class EvidenceLookupError(LookupError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)

def _format_reference_sql(reference_sql: str) -> str | None:
    try:
        statements = [
            statement for statement in sqlglot.parse(reference_sql, read="duckdb")
            if statement is not None
        ]
    except ParseError:
        return None
    if len(statements) != 1 or not reference_sql.strip():
        return None
    return statements[0].sql(dialect="duckdb", pretty=True)


def _billable_pricing(model: ModelRun) -> dict[str, Any] | None:
    if (
        model.adapter_kind_snapshot == "pi"
        and model.parameters_snapshot_json.get("auth_mode", "api_key") == "oauth"
    ):
        return None
    return model.pricing_snapshot_json


async def invocation_evidence(session: AsyncSession, run_id: int) -> dict[int, dict[str, Any]]:
    """Read actual per-call controls, not the zero-request readiness snapshot."""
    allowed = {
        "harness",
        "harness_version",
        "bridge_sha256",
        "dependency_lock_sha256",
        "policy_version",
        "system_prompt_sha256",
        "provider",
        "auth_mode",
        "api",
        "model_identity_source",
        "requested_model_id",
        "effective_parameters",
        "generation_attempts",
        "generation_attempt_limit",
        "retry_limit",
        "tools_enabled",
        "tool_count",
        "tool_calls_observed",
        "context_isolated",
        "wire_payload_sha256",
        "parameter_notes",
    }
    evidence: dict[int, dict[str, Any]] = {}
    rows = (
        await session.execute(
            select(RunEvent.case_run_id, RunEvent.event_type, RunEvent.payload_json)
            .where(
                RunEvent.comparison_run_id == run_id,
                RunEvent.event_type.in_(["provider.requested", "provider.completed"]),
            )
            .order_by(RunEvent.seq)
        )
    ).all()
    for case_id, event_type, payload in rows:
        if case_id is None:
            continue
        values = payload.get("invocation", {}) if event_type == "provider.requested" else payload
        if not isinstance(values, dict) or values.get("harness") != "pi-ai":
            continue
        current = evidence.setdefault(case_id, {})
        current.update({key: value for key, value in values.items() if key in allowed})
        current["status"] = (
            "request_recorded"
            if event_type == "provider.requested"
            else "failed"
            if payload.get("status") == "failed"
            else "completed"
        )
    return evidence


async def build_run_snapshot(session: AsyncSession, run_id: int) -> dict[str, Any]:
    run = await session.get(ComparisonRun, run_id)
    if run is None:
        raise EvidenceLookupError("run_not_found", "运行不存在")
    models = list(
        (
            await session.scalars(
                select(ModelRun)
                .where(ModelRun.comparison_run_id == run_id)
                .order_by(ModelRun.selection_order)
            )
        ).all()
    )
    profiles = {
        profile.id: profile
        for profile in (
            await session.scalars(
                select(ModelProfile).where(
                    ModelProfile.id.in_([model.model_profile_id for model in models])
                )
            )
        ).all()
    }
    actual_calls = await invocation_evidence(session, run_id)
    result_models: list[dict[str, Any]] = []
    for model in models:
        rows = (
            await session.execute(
                select(CaseRun, BenchmarkCase)
                .join(BenchmarkCase, BenchmarkCase.id == CaseRun.benchmark_case_id)
                .where(CaseRun.model_run_id == model.id)
                .order_by(BenchmarkCase.sort_order, CaseRun.attempt)
            )
        ).all()
        profile = profiles.get(model.model_profile_id)
        name = model.profile_name_snapshot or (
            profile.name if profile is not None else f"model-{model.model_profile_id}"
        )
        result_models.append(
            {
                "id": model.id,
                "name": name,
                "status": model.status,
                "official_score": model.official_score,
                "requested_model_id": model.requested_model_id,
                "resolved_model_id": model.resolved_model_id,
                "adapter_kind": model.adapter_kind_snapshot,
                "response_mode": model.response_mode_snapshot,
                "endpoint_fingerprint": (
                    hashlib.sha256(model.base_url_snapshot.encode()).hexdigest()
                    if model.base_url_snapshot
                    else None
                ),
                "parameters": model.parameters_snapshot_json,
                "pricing": _billable_pricing(model),
                "cli_version": model.cli_version_snapshot,
                "isolation": model.isolation_snapshot_json,
                "cases": [
                    {
                        "id": case_run.id,
                        "case_id": case.id,
                        "stable_key": case_run.stable_case_key_snapshot,
                        "title": case.title,
                        "question": case.question,
                        "weight": case.weight,
                        "category": case.category,
                        "radar_dimension": case.radar_dimension,
                        "attempt": case_run.attempt,
                        "status": case_run.status,
                        "visible_summary": case_run.visible_summary,
                        "formatted_sql": case_run.formatted_sql,
                        "generation_ms": case_run.generation_ms,
                        "execution_ms": case_run.execution_ms,
                        "provider_request_id": case_run.provider_request_id,
                        "token_usage": case_run.token_usage_json,
                        "score": case_run.score_breakdown_json,
                        "error_code": case_run.error_code,
                        "error_message": case_run.error_message,
                        "invocation": actual_calls.get(case_run.id),
                    }
                    for case_run, case in rows
                ],
            }
        )
    controls = {
        "adapter_kind": {model.adapter_kind_snapshot or "" for model in models},
        "base_url": {model.base_url_snapshot or "" for model in models},
        "response_mode": {model.response_mode_snapshot or "" for model in models},
        "parameters": {
            json.dumps(model.parameters_snapshot_json, ensure_ascii=False, sort_keys=True)
            for model in models
        },
        "cli_version": {model.cli_version_snapshot or "" for model in models},
    }
    differences = [field for field, values in controls.items() if len(values) > 1]
    all_pi_models = bool(models) and all(model.adapter_kind_snapshot == "pi" for model in models)
    if len(models) < 2:
        comparison_mode = "single_model"
    elif all_pi_models:
        comparison_mode = "controlled_harness"
    elif differences:
        comparison_mode = "access_path"
    else:
        comparison_mode = "pure_model"
    return {
        "id": run.id,
        "source_run_id": run.source_run_id,
        "suite_version_id": run.suite_version_id,
        "suite_content_hash": run.suite_content_hash,
        "selected_case_keys": run.selected_case_keys_json,
        "status": run.status,
        "attempts": run.attempts,
        "created_at": run.created_at,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "protocol": {
            "output_contract": run.output_contract_snapshot,
            "app_version": run.app_version_snapshot,
            "scorer_version": run.scorer_version_snapshot,
            "duckdb_version": run.duckdb_version_snapshot,
            "sqlglot_version": run.sqlglot_version_snapshot,
            "case_count": len(run.selected_case_keys_json),
            "attempts": run.attempts,
        },
        "fairness": {
            "comparison_mode": comparison_mode,
            "pure_model_comparison": comparison_mode == "pure_model",
            "controlled_fields": [field for field in controls if field not in differences],
            "differences": differences,
            "model_variable": [model.requested_model_id for model in models],
            "exact_rerun_default": True,
        },
        "models": result_models,
    }


def build_run_report(snapshot: dict[str, Any]) -> dict[str, Any]:
    model_reports: list[dict[str, Any]] = []
    selected = snapshot.get("selected_case_keys")
    attempts = snapshot.get("attempts")
    planned_total = (
        len(selected) * int(attempts)
        if isinstance(selected, list) and isinstance(attempts, int)
        else None
    )
    legacy = str(snapshot["protocol"]["scorer_version"]).split(".")[0] == "1"
    for model in snapshot["models"]:
        category_values: defaultdict[str, list[tuple[float, float]]] = defaultdict(list)
        attempts_by_case: defaultdict[str, list[float]] = defaultdict(list)
        for case in model["cases"]:
            score = float((case["score"] or {}).get("total", 0))
            category_values[case["radar_dimension"]].append((score, float(case["weight"])))
            attempts_by_case[case["stable_key"]].append(score)
            case["quality"] = case_result_quality(
                case.get("score"), legacy=legacy, error_code=case.get("error_code")
            )
        model_reports.append(
            {
                **model,
                "categories": {
                    name: round(weighted_average(values), 2)
                    for name, values in category_values.items()
                },
                "attempt_statistics": {
                    key: attempt_statistics(values) for key, values in attempts_by_case.items()
                },
                "failure_count": sum(case["status"] == "failed" for case in model["cases"]),
                "quality": aggregate_result_quality(
                    model["cases"], planned_total=planned_total, legacy=legacy
                ),
                "efficiency": aggregate_efficiency(
                    model["cases"], model["adapter_kind"], model.get("pricing"), legacy=legacy
                ),
            }
        )
    protocol = snapshot["protocol"]
    report = {
        **snapshot,
        "report_schema_version": "run-report-v3" if legacy else "run-report-v4",
        "quality_schema_version": "result-quality-v1" if legacy else QUALITY_SCHEMA_VERSION,
        "app_version": protocol["app_version"],
        "scorer_version": protocol["scorer_version"],
        "duckdb_version": protocol["duckdb_version"],
        "sqlglot_version": protocol["sqlglot_version"],
        "models": model_reports,
    }
    report["conclusion"] = (
        build_conclusion(report)
        if snapshot["status"] in {"completed", "completed_with_errors"}
        else {"status": "incomplete", "champions": [], "models": []}
    )
    return report


async def build_case_evidence(
    session: AsyncSession,
    case_run_id: int,
    *,
    include_reference: bool = False,
    artifact_root: Path | None = None,
) -> dict[str, Any]:
    row = (
        await session.execute(
            select(CaseRun, BenchmarkCase, ModelRun, ComparisonRun)
            .join(BenchmarkCase, BenchmarkCase.id == CaseRun.benchmark_case_id)
            .join(ModelRun, ModelRun.id == CaseRun.model_run_id)
            .join(ComparisonRun, ComparisonRun.id == ModelRun.comparison_run_id)
            .where(CaseRun.id == case_run_id)
        )
    ).one_or_none()
    if row is None:
        raise EvidenceLookupError("case_run_not_found", "Case run 不存在")
    case_run, case, model, run = row
    actual_calls = await invocation_evidence(session, run.id)
    result: dict[str, Any] = {
        "id": case_run.id,
        "run_id": run.id,
        "model_run_id": model.id,
        "model_name": model.profile_name_snapshot or f"model-{model.model_profile_id}",
        "requested_model_id": model.requested_model_id,
        "resolved_model_id": model.resolved_model_id,
        "stable_key": case_run.stable_case_key_snapshot,
        "title": case.title,
        "question": case.question,
        "category": case.category,
        "radar_dimension": case.radar_dimension,
        "difficulty": case.difficulty,
        "status": case_run.status,
        "attempt": case_run.attempt,
        "started_at": case_run.started_at,
        "finished_at": case_run.finished_at,
        "prompt": case_run.prompt_snapshot,
        "raw_output": case_run.raw_output,
        "plan": case_run.plan_json,
        "assumptions": case_run.assumptions_json,
        "visible_summary": case_run.visible_summary,
        "generated_sql": case_run.generated_sql,
        "formatted_sql": case_run.formatted_sql,
        "generation_ms": case_run.generation_ms,
        "execution_ms": case_run.execution_ms,
        "provider_request_id": case_run.provider_request_id,
        "token_usage": case_run.token_usage_json,
        "efficiency": case_efficiency(
            {
                "token_usage": case_run.token_usage_json,
                "generation_ms": case_run.generation_ms,
                "execution_ms": case_run.execution_ms,
            },
            model.adapter_kind_snapshot,
            _billable_pricing(model),
        ),
        "expected_digest": case_run.expected_digest,
        "actual_digest": case_run.actual_digest,
        "result_preview": (
            dict(case_run.result_preview_json)
            if case_run.result_preview_json is not None
            else None
        ),
        "score": case_run.score_breakdown_json,
        "error_code": case_run.error_code,
        "error_message": case_run.error_message,
        "required_ast": case.required_ast_json,
        "invocation": actual_calls.get(case_run.id),
        "comparison": case.comparison_json,
        "suite_content_hash": run.suite_content_hash,
    }
    if not include_reference:
        if result["result_preview"] is not None:
            result["result_preview"].pop("missing", None)
            result["result_preview"].pop("extra", None)
        return result
    if case_run.status != "completed":
        raise EvidenceLookupError("reference_not_available", "仅完成 case 可查看参考证据")
    root = artifact_root or settings.var_dir / "suites"
    gold_path = root / run.suite_content_hash / "gold" / f"{case_run.stable_case_key_snapshot}.json"
    if not gold_path.exists():
        raise EvidenceLookupError("gold_artifact_missing", "固定金标结果资产不存在")
    gold = json.loads(gold_path.read_text(encoding="utf-8"))
    result["reference_sql"] = case.reference_sql
    result["formatted_reference_sql"] = _format_reference_sql(case.reference_sql)
    result["expected_result_preview"] = {
        "columns": gold["columns"],
        "rows": gold["rows"][:200],
        "row_count": len(gold["rows"]),
        "digest": gold["digest"],
    }
    return result
