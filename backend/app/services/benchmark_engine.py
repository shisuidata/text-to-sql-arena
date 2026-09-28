from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any, cast

from pydantic import TypeAdapter
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from backend.app.adapters.base import (
    AdapterError,
    AdapterProfile,
    GenerationResponse,
    ModelAdapter,
)
from backend.app.adapters.registry import AdapterRegistry, adapter_registry
from backend.app.config import settings
from backend.app.db import SessionLocal
from backend.app.domain import (
    AstRule,
    BenchmarkCaseDefinition,
    ComparisonConfig,
    SemanticLayer,
    StructureSnapshot,
)
from backend.app.models import (
    BenchmarkCase,
    CaseRun,
    ComparisonRun,
    ModelRun,
    SuiteVersion,
)
from backend.app.security import redact_secrets
from backend.app.services.events import BufferedEventSink, EventWriter, event_writer
from backend.app.services.sql_evaluator import EvaluationOutcome, evaluate_case, weighted_average
from backend.app.services.suites import build_generation_request

TERMINAL_COMPARISON = {
    "completed",
    "completed_with_errors",
    "failed",
    "cancelled",
    "interrupted",
}

AST_RULES_ADAPTER = TypeAdapter(list[AstRule])
JSON_OBJECT_ADAPTER = TypeAdapter(dict[str, Any])


class BenchmarkEngine:
    def __init__(
        self,
        registry: AdapterRegistry | None = None,
        writer: EventWriter | None = None,
    ) -> None:
        self.registry = registry or adapter_registry
        self.writer = writer or event_writer
        self._run_cancellations: dict[int, asyncio.Event] = {}
        self._tasks: dict[int, asyncio.Task[None]] = {}
        self._global = asyncio.Semaphore(3)
        self._adapter_limits = {"pi": asyncio.Semaphore(2)}

    def launch(self, run_id: int) -> None:
        task = asyncio.create_task(self.start_run(run_id))
        self._tasks[run_id] = task
        task.add_done_callback(lambda _: self._tasks.pop(run_id, None))

    async def cancel(self, run_id: int) -> str:
        async with SessionLocal.begin() as session:
            run = await session.get(ComparisonRun, run_id)
            if run is None:
                raise LookupError(f"Run not found: {run_id}")
            if run.status in TERMINAL_COMPARISON:
                return run.status
            run.status = "cancelling"
            run.cancellation_requested_at = datetime.now(UTC)
        event = self._run_cancellations.get(run_id)
        if event is not None:
            event.set()
        return "cancelling"

    async def start_run(self, run_id: int) -> None:
        cancel = asyncio.Event()
        self._run_cancellations[run_id] = cancel
        try:
            status = await self._mark_run_started(run_id)
            if status == "cancelling":
                cancel.set()
                await self._finalize_run(run_id, cancel)
                return
            if status != "running":
                return
            async with SessionLocal() as session:
                model_ids = list(
                    (
                        await session.scalars(
                            select(ModelRun.id)
                            .where(ModelRun.comparison_run_id == run_id)
                            .order_by(ModelRun.selection_order)
                        )
                    ).all()
                )
            await asyncio.gather(
                *(self._run_model(run_id, model_id, cancel) for model_id in model_ids)
            )
            await self._finalize_run(run_id, cancel)
        except Exception as exc:
            await self._fail_run(run_id, exc)
        finally:
            self._run_cancellations.pop(run_id, None)

    async def _mark_run_started(self, run_id: int) -> str:
        now = datetime.now(UTC)
        started = False
        async with SessionLocal.begin() as session:
            run = await session.get(ComparisonRun, run_id)
            if run is None:
                raise LookupError(f"Run not found: {run_id}")
            if run.status == "queued":
                run.status = "running"
                run.started_at = now
                started = True
            status = run.status
        if started:
            await self.writer.emit(run_id, "run.started", "info", {"status": "running"})
        return status

    async def _load_context(
        self, model_run_id: int
    ) -> tuple[ModelRun, ComparisonRun, SuiteVersion, list[tuple[CaseRun, BenchmarkCase]]]:
        async with SessionLocal() as session:
            model = await session.get(ModelRun, model_run_id)
            if model is None:
                raise LookupError(f"Model run not found: {model_run_id}")
            run = await session.get(ComparisonRun, model.comparison_run_id)
            if run is None:
                raise LookupError(f"Run not found: {model.comparison_run_id}")
            suite = await session.scalar(
                select(SuiteVersion)
                .options(selectinload(SuiteVersion.cases))
                .where(SuiteVersion.id == run.suite_version_id)
            )
            if suite is None:
                raise LookupError(f"Suite version not found: {run.suite_version_id}")
            rows = (
                await session.execute(
                    select(CaseRun, BenchmarkCase)
                    .join(BenchmarkCase, BenchmarkCase.id == CaseRun.benchmark_case_id)
                    .where(CaseRun.model_run_id == model_run_id)
                    .order_by(BenchmarkCase.sort_order, CaseRun.attempt)
                )
            ).all()
            session.expunge_all()
        return model, run, suite, [(row[0], row[1]) for row in rows]

    async def _run_model(
        self,
        run_id: int,
        model_run_id: int,
        cancel: asyncio.Event,
    ) -> None:
        async with (
            self._global,
            self._adapter_limits[(await self._model_adapter_kind(model_run_id))],
        ):
            model, run, suite, case_rows = await self._load_context(model_run_id)
            await self._set_model_status(model_run_id, "running")
            await self.writer.emit(
                run_id,
                "model.started",
                "info",
                {"status": "running"},
                model_run_id=model_run_id,
            )
            adapter = self.registry.get(model.adapter_kind_snapshot)
            profile = AdapterProfile(
                id=model.model_profile_id,
                name=f"snapshot-{model.id}",
                adapter_kind=model.adapter_kind_snapshot,
                model_id=model.requested_model_id,
                base_url=model.base_url_snapshot,
                response_mode=model.response_mode_snapshot,
                api_key_ref=model.api_key_ref_snapshot,
                parameters=model.parameters_snapshot_json,
            )
            semantic = SemanticLayer.model_validate(suite.semantic_layer_json)
            structure = StructureSnapshot.model_validate(suite.structure_snapshot_json)
            for case_run, case in case_rows:
                if cancel.is_set():
                    await self._set_case_cancelled(case_run.id)
                    continue
                await self._run_case(
                    run,
                    suite,
                    model,
                    case_run,
                    case,
                    profile,
                    adapter,
                    semantic,
                    structure,
                    cancel,
                )
            await self._finalize_model(run_id, model_run_id, cancel)

    async def _model_adapter_kind(self, model_run_id: int) -> str:
        async with SessionLocal() as session:
            value = await session.scalar(
                select(ModelRun.adapter_kind_snapshot).where(ModelRun.id == model_run_id)
            )
        if value is None:
            raise LookupError(f"Model run not found: {model_run_id}")
        return str(value)

    def _case_definition(self, case: BenchmarkCase) -> BenchmarkCaseDefinition:
        return BenchmarkCaseDefinition(
            stable_key=case.stable_key,
            title=case.title,
            category=case.category,
            radar_dimension=case.radar_dimension,
            difficulty=case.difficulty,
            question=case.question,
            reference_sql=case.reference_sql,
            required_ast=AST_RULES_ADAPTER.validate_python(case.required_ast_json),
            comparison=ComparisonConfig.model_validate(case.comparison_json),
            weight=case.weight,
            sort_order=case.sort_order,
        )

    async def _run_case(
        self,
        run: ComparisonRun,
        suite: SuiteVersion,
        model: ModelRun,
        case_run: CaseRun,
        case: BenchmarkCase,
        profile: AdapterProfile,
        adapter: ModelAdapter,
        semantic: SemanticLayer,
        structure: StructureSnapshot,
        cancel: asyncio.Event,
    ) -> None:
        definition = self._case_definition(case)
        started = datetime.now(UTC)
        await self._set_case_status(case_run.id, "generating", started_at=started)
        await self.writer.emit(
            run.id,
            "case.started",
            "info",
            {"status": "generating"},
            model_run_id=model.id,
            case_run_id=case_run.id,
        )
        generation_request = build_generation_request(
            suite.prompt_template, structure, semantic, definition
        )
        async with SessionLocal.begin() as session:
            stored = await session.get(CaseRun, case_run.id)
            assert stored is not None
            stored.prompt_snapshot = generation_request.prompt
        await self.writer.emit(
            run.id,
            "prompt.built",
            "info",
            {"status": "completed"},
            model_run_id=model.id,
            case_run_id=case_run.id,
        )

        async def raw_sink(event_type: str, level: str, payload: dict[str, Any]) -> None:
            await self.writer.emit(
                run.id,
                event_type,
                level,
                payload,
                model_run_id=model.id,
                case_run_id=case_run.id,
            )

        sink = BufferedEventSink(raw_sink)
        generated: GenerationResponse | None = None
        outcome: EvaluationOutcome | None = None
        try:
            generated = await adapter.generate(profile, generation_request, sink, cancel)
            await sink.flush()
            await self.writer.emit(
                run.id,
                "plan.completed",
                "info",
                {
                    "status": "completed",
                    "grain": generated.parsed_output.plan.grain,
                    "steps": len(generated.parsed_output.plan.steps),
                },
                model_run_id=model.id,
                case_run_id=case_run.id,
            )
            await self._set_case_status(case_run.id, "validating")
            await self.writer.emit(
                run.id,
                "sql.parsed",
                "info",
                {"status": "completed"},
                model_run_id=model.id,
                case_run_id=case_run.id,
            )
            artifact = settings.var_dir / "suites" / run.suite_content_hash
            outcome = await asyncio.to_thread(
                evaluate_case,
                sql=generated.parsed_output.sql,
                warehouse_path=artifact / "warehouse.duckdb",
                gold_path=artifact / "gold" / f"{case.stable_key}.json",
                allowed_tables={table.name for table in structure.tables},
                comparison=definition.comparison,
                required_ast=definition.required_ast,
                protocol_strict=generated.protocol_strict,
            )
            if outcome.error_code:
                raise AdapterError(outcome.error_code, outcome.error_message or "SQL 评估失败")
            await self._store_case_success(case_run.id, generated, outcome)
            await self.writer.emit(
                run.id,
                "score.completed",
                "info",
                {"status": "completed", "score": outcome.score.total},
                model_run_id=model.id,
                case_run_id=case_run.id,
            )
        except AdapterError as exc:
            await sink.flush()
            if exc.code == "cancelled" or cancel.is_set():
                await self._set_case_cancelled(case_run.id)
                return
            await self._store_case_failure(
                case_run.id,
                exc.code,
                str(exc),
                generated=generated,
                outcome=outcome,
                raw_output=exc.details.get("raw_output"),
            )
            await self.writer.emit(
                run.id,
                "case.failed",
                "error",
                {"status": "failed", "error_code": exc.code},
                message=str(exc),
                model_run_id=model.id,
                case_run_id=case_run.id,
            )
        except Exception as exc:
            await sink.flush()
            await self._store_case_failure(
                case_run.id,
                "internal_error",
                str(exc),
                generated=generated,
                outcome=outcome,
            )
            await self.writer.emit(
                run.id,
                "case.failed",
                "error",
                {"status": "failed", "error_code": "internal_error"},
                message=str(exc),
                model_run_id=model.id,
                case_run_id=case_run.id,
            )

    async def _set_model_status(self, model_run_id: int, status: str) -> None:
        async with SessionLocal.begin() as session:
            model = await session.get(ModelRun, model_run_id)
            assert model is not None
            model.status = status

    async def _set_case_status(
        self,
        case_run_id: int,
        status: str,
        *,
        started_at: datetime | None = None,
    ) -> None:
        async with SessionLocal.begin() as session:
            case = await session.get(CaseRun, case_run_id)
            assert case is not None
            case.status = status
            if started_at is not None:
                case.started_at = started_at

    async def _set_case_cancelled(self, case_run_id: int) -> None:
        async with SessionLocal.begin() as session:
            case = await session.get(CaseRun, case_run_id)
            assert case is not None
            if case.status not in {"completed", "failed"}:
                case.status = "cancelled"
                case.finished_at = datetime.now(UTC)

    async def _store_case_success(
        self,
        case_run_id: int,
        generated: GenerationResponse,
        outcome: EvaluationOutcome,
    ) -> None:
        async with SessionLocal.begin() as session:
            case = await session.get(CaseRun, case_run_id)
            assert case is not None
            model = await session.get(ModelRun, case.model_run_id)
            assert model is not None
            output = generated.parsed_output
            case.status = "completed"
            case.raw_output = str(redact_secrets(generated.raw_output))
            case.plan_json = redact_secrets(output.plan.model_dump(mode="json"))
            case.assumptions_json = redact_secrets(output.assumptions)
            case.visible_summary = str(redact_secrets(output.summary))
            case.generated_sql = str(redact_secrets(output.sql))
            case.formatted_sql = (
                str(redact_secrets(outcome.formatted_sql))
                if outcome.formatted_sql is not None
                else None
            )
            case.generation_ms = generated.latency_ms
            case.execution_ms = outcome.execution_ms
            case.provider_request_id = generated.provider_request_id
            case.token_usage_json = redact_secrets(generated.token_usage)
            assert outcome.diff is not None
            case.expected_digest = outcome.diff.expected_digest
            case.actual_digest = outcome.diff.actual_digest
            case.result_preview_json = self._result_preview(outcome)
            case.score_breakdown_json = outcome.score.model_dump(mode="json")
            case.finished_at = datetime.now(UTC)
            model.resolved_model_id = generated.resolved_model_id

    def _result_preview(self, outcome: EvaluationOutcome) -> dict[str, Any] | None:
        if outcome.actual is None or outcome.diff is None:
            return None
        return cast(
            dict[str, Any],
            JSON_OBJECT_ADAPTER.dump_python(
                {
                    "columns": [
                        column.model_dump(mode="json") for column in outcome.actual.columns
                    ],
                    "rows": outcome.actual.rows[:200],
                    "row_count": len(outcome.actual.rows),
                    "missing": outcome.diff.missing_rows,
                    "extra": outcome.diff.extra_rows,
                    "comparison_summary": {
                        "verdict": outcome.diff.verdict,
                        "expected_count": outcome.diff.expected_count,
                        "actual_count": outcome.diff.actual_count,
                        "matched_count": outcome.diff.matched_count,
                        "missing_count": outcome.diff.expected_count - outcome.diff.matched_count,
                        "extra_count": outcome.diff.actual_count - outcome.diff.matched_count,
                        "order_mismatch": outcome.diff.f1 == 1 and not outcome.diff.ordered_equal,
                    },
                },
                mode="json",
            ),
        )

    async def _store_case_failure(
        self,
        case_run_id: int,
        code: str,
        message: str,
        *,
        generated: GenerationResponse | None = None,
        outcome: EvaluationOutcome | None = None,
        raw_output: str | None = None,
    ) -> None:
        async with SessionLocal.begin() as session:
            case = await session.get(CaseRun, case_run_id)
            assert case is not None
            case.status = "failed"
            case.error_code = code
            case.error_message = str(redact_secrets(message))
            unsafe_raw = generated.raw_output if generated is not None else raw_output
            case.raw_output = str(redact_secrets(unsafe_raw)) if unsafe_raw is not None else None
            if generated is not None:
                output = generated.parsed_output
                case.plan_json = redact_secrets(output.plan.model_dump(mode="json"))
                case.assumptions_json = redact_secrets(output.assumptions)
                case.visible_summary = str(redact_secrets(output.summary))
                case.generated_sql = str(redact_secrets(output.sql))
                case.generation_ms = generated.latency_ms
                case.provider_request_id = generated.provider_request_id
                case.token_usage_json = redact_secrets(generated.token_usage)
                model = await session.get(ModelRun, case.model_run_id)
                if model is not None:
                    model.resolved_model_id = generated.resolved_model_id
            if outcome is not None:
                case.formatted_sql = (
                    str(redact_secrets(outcome.formatted_sql))
                    if outcome.formatted_sql is not None
                    else None
                )
                case.execution_ms = outcome.execution_ms
                case.result_preview_json = self._result_preview(outcome)
                case.score_breakdown_json = outcome.score.model_dump(mode="json")
                if outcome.diff is not None:
                    case.expected_digest = outcome.diff.expected_digest
                    case.actual_digest = outcome.diff.actual_digest
            else:
                case.score_breakdown_json = {"total": 0.0}
            case.finished_at = datetime.now(UTC)

    async def _finalize_model(self, run_id: int, model_run_id: int, cancel: asyncio.Event) -> None:
        async with SessionLocal.begin() as session:
            rows = (
                await session.execute(
                    select(CaseRun, BenchmarkCase)
                    .join(BenchmarkCase, BenchmarkCase.id == CaseRun.benchmark_case_id)
                    .where(CaseRun.model_run_id == model_run_id)
                )
            ).all()
            model = await session.get(ModelRun, model_run_id)
            assert model is not None
            if cancel.is_set():
                model.status = "cancelled"
            else:
                completed = sum(case.status == "completed" for case, _ in rows)
                failed = sum(case.status == "failed" for case, _ in rows)
                if completed and failed:
                    model.status = "completed_with_errors"
                elif completed:
                    model.status = "completed"
                else:
                    model.status = "failed"
            model.official_score = round(
                weighted_average(
                    (float((case.score_breakdown_json or {}).get("total", 0)), benchmark.weight)
                    for case, benchmark in rows
                ),
                2,
            )
        await self.writer.emit(
            run_id,
            "model.completed",
            "info",
            {"status": model.status, "score": model.official_score},
            model_run_id=model_run_id,
        )

    async def _finalize_run(self, run_id: int, cancel: asyncio.Event) -> None:
        async with SessionLocal.begin() as session:
            run = await session.get(ComparisonRun, run_id)
            assert run is not None
            if run.status in TERMINAL_COMPARISON:
                return
            models = list(
                (
                    await session.scalars(
                        select(ModelRun).where(ModelRun.comparison_run_id == run_id)
                    )
                ).all()
            )
            if cancel.is_set() or run.status == "cancelling":
                run.status = "cancelled"
            else:
                success = sum(
                    model.status in {"completed", "completed_with_errors"} for model in models
                )
                errors = sum(
                    model.status in {"failed", "completed_with_errors"} for model in models
                )
                run.status = (
                    "failed" if success == 0 else "completed_with_errors" if errors else "completed"
                )
            run.finished_at = datetime.now(UTC)
        event_type = "run.cancelled" if run.status == "cancelled" else "run.completed"
        await self.writer.emit(run_id, event_type, "info", {"status": run.status})

    async def _fail_run(self, run_id: int, error: Exception) -> None:
        async with SessionLocal.begin() as session:
            run = await session.get(ComparisonRun, run_id)
            if run is None or run.status in TERMINAL_COMPARISON:
                return
            run.status = "failed"
            run.finished_at = datetime.now(UTC)
        await self.writer.emit(
            run_id,
            "run.completed",
            "error",
            {"status": "failed", "error_code": "internal_error"},
            message=str(error),
        )


benchmark_engine = BenchmarkEngine()
