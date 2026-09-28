from __future__ import annotations

import asyncio
import json
import time
import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast

import pytest
import yaml
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import selectinload

from backend.app.adapters.base import (
    AdapterError,
    AdapterHealth,
    AdapterProfile,
    EventSink,
    GenerationResponse,
)
from backend.app.adapters.pi import preview_pi_import
from backend.app.adapters.registry import adapter_registry
from backend.app.db import SessionLocal
from backend.app.domain import GenerationOutput, GenerationRequest, QueryPlan
from backend.app.main import app
from backend.app.models import (
    BenchmarkCase,
    BenchmarkSuite,
    CaseRun,
    ComparisonRun,
    ModelProfile,
    ModelRun,
    SuiteVersion,
)
from backend.app.services.evidence import export_all_evidence, verify_evidence

TERMINAL = {"completed", "completed_with_errors", "failed", "cancelled", "interrupted"}
DATA_DIR = Path(__file__).parents[1] / "backend" / "app" / "data" / "retail-analytics-v1"
REFERENCES = {
    case["stable_key"]: case["reference_sql"]
    for case in yaml.safe_load((DATA_DIR / "cases.yaml").read_text())
}


def _result_preview_fixture() -> dict[str, Any]:
    return {
        "columns": [{"name": "id", "type": "BIGINT"}],
        "rows": [[2]],
        "row_count": 1,
        "missing": [["1", "甲"]],
        "extra": [["3", "丙"]],
        "comparison_summary": {
            "verdict": "different",
            "expected_count": 3,
            "actual_count": 3,
            "matched_count": 2,
            "missing_count": 1,
            "extra_count": 1,
            "order_mismatch": False,
        },
    }


def test_case_evidence_redaction_copies_preview_and_formats_reference(tmp_path: Path) -> None:
    from backend.app.db import Base, engine
    from backend.app.services.reporting import _format_reference_sql, build_case_evidence

    assert _format_reference_sql("select 999") == "SELECT\n  999"
    assert _format_reference_sql("select 1; select 2") is None
    assert _format_reference_sql("not sql!") is None

    gold_dir = tmp_path / "evidence-format-hash" / "gold"
    gold_dir.mkdir(parents=True)
    (gold_dir / "case-a.json").write_text(
        json.dumps(
            {
                "columns": [{"name": "id", "type": "BIGINT"}],
                "rows": [[1]],
                "digest": "gold-digest",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    async def scenario() -> None:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        suite = BenchmarkSuite(name="evidence-isolated", description="")
        version = SuiteVersion(
            suite=suite,
            version=1,
            status="published",
            dialect="duckdb",
            schema_sql="",
            seed_sql="",
            semantic_layer_json={},
            prompt_template="",
            content_hash="evidence-format-hash",
        )
        case = BenchmarkCase(
            suite_version=version,
            stable_key="case-a",
            title="题 A",
            category="filter",
            radar_dimension="基础查询",
            difficulty="easy",
            question="q",
            reference_sql="select 999",
            required_ast_json=[],
            comparison_json={},
            sort_order=1,
        )
        profile = ModelProfile(
            name="evidence-historical",
            adapter_kind="codex_cli",
            model_id="model",
            base_url=None,
            response_mode="text",
            parameters_json={},
            pricing_json=None,
            enabled=True,
            health_status="unknown",
            health_details_json={},
        )
        async with SessionLocal() as session:
            session.add_all([suite, version, case, profile])
            await session.flush()
            run = ComparisonRun(
                suite_version_id=version.id,
                suite_content_hash="evidence-format-hash",
                selected_case_keys_json=["case-a"],
                status="completed",
            )
            session.add(run)
            await session.flush()
            model_run = ModelRun(
                comparison_run_id=run.id,
                model_profile_id=profile.id,
                selection_order=0,
                adapter_kind_snapshot="codex_cli",
                response_mode_snapshot="text",
                requested_model_id="model",
                parameters_snapshot_json={},
            )
            session.add(model_run)
            await session.flush()
            case_run = CaseRun(
                model_run_id=model_run.id,
                benchmark_case_id=case.id,
                stable_case_key_snapshot="case-a",
                attempt=1,
                status="completed",
                result_preview_json=_result_preview_fixture(),
                score_breakdown_json={"total": 80},
            )
            session.add(case_run)
            await session.commit()
            case_run_id = case_run.id
            try:
                hidden = await build_case_evidence(session, case_run_id)
                revealed = await build_case_evidence(
                    session, case_run_id, include_reference=True, artifact_root=tmp_path
                )
                fresh = await session.get(CaseRun, case_run_id)
            finally:
                await session.execute(delete(CaseRun).where(CaseRun.id == case_run_id))
                await session.execute(delete(ModelRun).where(ModelRun.id == model_run.id))
                await session.execute(delete(ComparisonRun).where(ComparisonRun.id == run.id))
                await session.execute(delete(ModelProfile).where(ModelProfile.id == profile.id))
                await session.execute(delete(BenchmarkCase).where(BenchmarkCase.id == case.id))
                await session.execute(delete(SuiteVersion).where(SuiteVersion.id == version.id))
                await session.execute(delete(BenchmarkSuite).where(BenchmarkSuite.id == suite.id))
                await session.commit()

        assert "missing" not in hidden["result_preview"]
        assert "extra" not in hidden["result_preview"]
        assert hidden["result_preview"]["comparison_summary"] == _result_preview_fixture()[
            "comparison_summary"
        ]
        assert "reference_sql" not in hidden
        assert "formatted_reference_sql" not in hidden
        assert revealed["reference_sql"] == "select 999"
        assert revealed["formatted_reference_sql"] == "SELECT\n  999"
        assert revealed["result_preview"]["missing"] == [["1", "甲"]]
        assert fresh is not None and fresh.result_preview_json is not None
        assert fresh.result_preview_json["missing"] == [["1", "甲"]]

    asyncio.run(scenario())


class FixtureAdapter:
    async def check(self, profile: AdapterProfile) -> AdapterHealth:
        return AdapterHealth(
            status="healthy",
            message="fixture ready",
            resolved_model_id=profile.model_id,
            version="fixture-1",
        )

    async def generate(
        self,
        profile: AdapterProfile,
        request: GenerationRequest,
        emit: EventSink,
        cancel: asyncio.Event,
    ) -> GenerationResponse:
        await emit("provider.requested", "info", {"model": profile.model_id})
        if profile.model_id == "always-fail":
            raise AdapterError(
                "fixture_failure",
                "planned model failure api_key=private-token at /Users/private/secret",
            )
        if profile.model_id == "slow-model":
            for _ in range(100):
                if cancel.is_set():
                    raise AdapterError("cancelled", "cancelled")
                await asyncio.sleep(0.01)
        output = GenerationOutput(
            plan=QueryPlan(
                grain="reference result grain",
                sources=[],
                joins=[],
                filters=[],
                metrics=["reference result"],
                steps=["execute reference-equivalent query"],
                risks=[],
            ),
            sql=REFERENCES[request.case_key],
            summary="fixture reference answer",
            assumptions=[],
        )
        await emit("provider.completed", "info", {"model": profile.model_id})
        return GenerationResponse(
            raw_output=output.model_dump_json(),
            parsed_output=output,
            resolved_model_id=profile.model_id,
            token_usage={"input_tokens": 10, "output_tokens": 20},
            latency_ms=1.0,
            provider_request_id=f"fixture-{profile.model_id}-{request.case_key}",
            protocol_strict=True,
        )


def csrf(client: TestClient) -> dict[str, str]:
    token = client.get("/api/bootstrap").json()["csrf_token"]
    return {"X-CSRF-Token": token}


def create_profile(
    client: TestClient, headers: dict[str, str], name: str, kind: str, model_id: str
) -> int:
    response = client.post(
        "/api/model-profiles",
        headers=headers,
        json={
            "name": name,
            "adapter_kind": kind,
            "model_id": model_id,
            "response_mode": "text",
            "parameters": {"provider": "openai"},
            "pricing": {
                "currency": "USD",
                "input_usd_per_million": 2.0,
                "cached_input_usd_per_million": 0.5,
                "cache_write_input_usd_per_million": 2.5,
                "output_usd_per_million": 8.0,
                "source": "test fixture",
                "effective_at": "2026-08-30",
            },
        },
    )
    assert response.status_code == 200, response.text
    profile_data = response.json()
    assert profile_data["parameters"] == {
        "provider": "openai",
        "auth_mode": "api_key",
        "timeout_seconds": 180.0,
    }
    profile_id = int(profile_data["id"])
    checked = client.post(f"/api/model-profiles/{profile_id}/check", headers=headers)
    assert checked.status_code == 200 and checked.json()["health_status"] == "healthy"
    return profile_id


def wait_for_run(client: TestClient, run_id: int, timeout: float = 30) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snapshot = client.get(f"/api/runs/{run_id}")
        assert snapshot.status_code == 200, snapshot.text
        payload = snapshot.json()
        assert isinstance(payload, dict)
        if payload["status"] in TERMINAL:
            return cast(dict[str, Any], payload)
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} did not finish")


def test_two_model_state_machine_resume_and_report(monkeypatch: Any, tmp_path: Path) -> None:
    fixture = FixtureAdapter()
    monkeypatch.setitem(adapter_registry._adapters, "pi", fixture)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        headers = csrf(client)
        good = create_profile(client, headers, "Reference", "pi", "reference-model")
        bad = create_profile(client, headers, "Failure", "pi", "always-fail")
        suite = client.get("/api/suites").json()[0]["versions"][0]
        preview = client.get(
            f"/api/suite-versions/{suite['id']}/prompt-preview?case_id={suite['cases'][0]['id']}"
        )
        assert preview.status_code == 200, preview.text
        assert suite["cases"][0]["question"] in preview.json()["prompt"]
        assert preview.json()["output_schema"]["required"] == [
            "plan",
            "sql",
            "summary",
            "assumptions",
        ]
        created = client.post(
            "/api/runs",
            headers=headers,
            json={
                "suite_version_id": suite["id"],
                "model_profile_ids": [good, bad],
                "case_ids": None,
                "attempts": 1,
            },
        )
        assert created.status_code == 200, created.text
        run_id = int(created.json()["id"])
        snapshot = wait_for_run(client, run_id)
        assert snapshot["status"] == "completed_with_errors"
        assert [model["status"] for model in snapshot["models"]] == ["completed", "failed"], (
            json.dumps(snapshot, ensure_ascii=False)
        )
        assert snapshot["models"][0]["official_score"] == 100.0
        assert snapshot["models"][1]["official_score"] == 0.0

        history = client.get(f"/api/runs/{run_id}/events/history?limit=5000").json()["events"]
        assert history == sorted(history, key=lambda event: event["seq"])
        assert any(event["event_type"] == "run.started" for event in history)
        model_started = [event for event in history if event["event_type"] == "model.started"]
        assert {event["model_run_id"] for event in model_started} == {
            model["id"] for model in snapshot["models"]
        }
        assert any(event["event_type"] == "case.failed" for event in history)
        assert any(event["event_type"] == "plan.completed" for event in history)
        assert "private-token" not in json.dumps(history)
        pivot = history[len(history) // 2]["seq"]
        resumed = client.get(
            f"/api/runs/{run_id}/events/history?after_seq={pivot}&limit=5000"
        ).json()["events"]
        assert resumed and all(event["seq"] > pivot for event in resumed)
        with client.stream("GET", f"/api/runs/{run_id}/events?after_seq={pivot}") as stream:
            streamed = [
                json.loads(line.removeprefix("data: "))
                for line in stream.iter_lines()
                if line.startswith("data: ")
            ]
        assert streamed and all(event["seq"] > pivot for event in streamed)
        assert all("message" in event and "payload" in event for event in streamed)
        # SQLite drops timezone metadata; replay/history must still identify UTC instants.
        assert all(
            datetime.fromisoformat(event["created_at"]).utcoffset() == timedelta(0)
            for event in [*history, *streamed]
        )
        history_times = {
            event["seq"]: datetime.fromisoformat(event["created_at"]) for event in history
        }
        assert all(
            datetime.fromisoformat(event["created_at"]) == history_times[event["seq"]]
            for event in streamed
        )

        case_run = snapshot["models"][0]["cases"][0]
        hidden = client.get(f"/api/case-runs/{case_run['id']}").json()
        revealed = client.get(f"/api/case-runs/{case_run['id']}?include_reference=true").json()
        assert "reference_sql" not in hidden
        assert "expected_result_preview" not in hidden
        assert hidden["plan"]["grain"] == "reference result grain"
        assert hidden["assumptions"] == []
        assert hidden["raw_output"]
        assert hidden["generation_ms"] == 1.0
        assert hidden["provider_request_id"].startswith("fixture-reference-model-")
        assert revealed["reference_sql"] == REFERENCES[case_run["stable_key"]]
        assert revealed["expected_result_preview"]["digest"] == revealed["expected_digest"]
        assert revealed["expected_result_preview"]["row_count"] >= 1

        report = client.get(f"/api/runs/{run_id}/report")
        assert report.status_code == 200
        report_data = report.json()
        assert report_data["conclusion"]["champions"] == ["Reference"]
        assert report_data["fairness"]["comparison_mode"] == "controlled_harness"
        assert report_data["fairness"]["pure_model_comparison"] is False
        assert {"adapter_kind", "parameters"} <= set(report_data["fairness"]["controlled_fields"])
        assert set(report_data["models"][0]["categories"]) == {
            "基础查询",
            "连接与粒度",
            "聚合与指标",
            "时间与窗口",
            "复杂查询",
            "数据开发",
        }
        assert report_data["models"][0]["efficiency"]["tokens"]["total"] == 540
        assert report_data["models"][0]["efficiency"]["estimated_cost_usd"] == 0.00324
        assert report_data["models"][0]["efficiency"]["generation_ms"]["p95"] == 1.0
        assert report_data["models"][0]["efficiency"]["per_correct_case"] == {
            "tokens": 30.0,
            "estimated_cost_usd": 0.00018,
            "generation_ms": 1.0,
        }
        recent = client.get("/api/runs").json()["runs"]
        assert any(item["id"] == run_id and item["case_count"] == 18 for item in recent)

        patched = client.patch(
            f"/api/model-profiles/{good}",
            headers=headers,
            json={"name": "Renamed Current Profile", "model_id": "mutated-current-model"},
        )
        assert patched.status_code == 200, patched.text
        exact = client.post(f"/api/runs/{run_id}/rerun", headers=headers)
        assert exact.status_code == 200, exact.text
        exact_snapshot = wait_for_run(client, int(exact.json()["id"]))
        assert exact_snapshot["source_run_id"] == run_id
        assert exact_snapshot["suite_content_hash"] == snapshot["suite_content_hash"]
        assert exact_snapshot["models"][0]["requested_model_id"] == "reference-model"
        assert exact_snapshot["models"][0]["parameters"] == snapshot["models"][0]["parameters"]
        assert exact_snapshot["models"][0]["name"] == "Reference"
        frozen_report = client.get(f"/api/runs/{run_id}/report").json()
        assert frozen_report["models"][0]["name"] == "Reference"

        evidence_dir = tmp_path / "evidence"
        index = asyncio.run(export_all_evidence(evidence_dir))
        assert any(item["run_id"] == run_id for item in index["runs"])
        verified = verify_evidence(evidence_dir)
        assert verified["run_count"] >= 2
        public_text = "\n".join(
            path.read_text(encoding="utf-8") for path in evidence_dir.rglob("*") if path.is_file()
        )
        assert "private-token" not in public_text
        assert "/Users/" not in public_text
        report_path = evidence_dir / "runs" / f"run-{run_id:04d}" / "report.json"
        original_report = report_path.read_text(encoding="utf-8")
        report_path.write_text(original_report + " ", encoding="utf-8")
        with pytest.raises(RuntimeError, match="digest mismatch"):
            verify_evidence(evidence_dir)
        report_path.write_text(original_report, encoding="utf-8")
        assert verify_evidence(evidence_dir) == verified
        json.dumps(report_data)


def test_browser_safety_rejects_untrusted_requests() -> None:
    with TestClient(app, base_url="http://127.0.0.1") as client:
        untrusted_host = client.get("/api/health", headers={"Host": "evil.example"})
        assert untrusted_host.status_code == 403
        assert untrusted_host.json()["code"] == "host_forbidden"

        untrusted_origin = client.get("/api/health", headers={"Origin": "https://evil.example"})
        assert untrusted_origin.status_code == 403
        assert untrusted_origin.json()["code"] == "origin_forbidden"

        missing_csrf = client.post("/api/runs", json={})
        assert missing_csrf.status_code == 403
        assert missing_csrf.json()["code"] == "csrf_forbidden"

def test_suite_catalog_is_read_only_and_hides_drafts() -> None:
    async def seed_drafts() -> tuple[str, int, int, int, str]:
        async with SessionLocal() as session:
            published = await session.scalar(
                select(SuiteVersion)
                .options(selectinload(SuiteVersion.suite), selectinload(SuiteVersion.cases))
                .where(SuiteVersion.status == "published")
                .limit(1)
            )
            assert published is not None
            assert published.cases
            latest = await session.scalar(
                select(func.max(SuiteVersion.version)).where(
                    SuiteVersion.suite_id == published.suite_id
                )
            )
            draft_only_name = f"draft-only-{time.time_ns()}"
            draft_only_suite = BenchmarkSuite(name=draft_only_name, description="hidden draft")
            session.add(draft_only_suite)
            await session.flush()
            draft_only = SuiteVersion(
                suite_id=draft_only_suite.id,
                version=1,
                status="draft",
                dialect=published.dialect,
                schema_sql=published.schema_sql,
                seed_sql=published.seed_sql,
                semantic_layer_json=published.semantic_layer_json,
                prompt_template=published.prompt_template,
                structure_snapshot_json=published.structure_snapshot_json,
            )
            mixed_draft = SuiteVersion(
                suite_id=published.suite_id,
                version=int(latest or 0) + 1,
                status="draft",
                dialect=published.dialect,
                schema_sql=published.schema_sql,
                seed_sql=published.seed_sql,
                semantic_layer_json=published.semantic_layer_json,
                prompt_template=published.prompt_template,
                structure_snapshot_json=published.structure_snapshot_json,
            )
            session.add_all([draft_only, mixed_draft])
            await session.flush()
            source_case = published.cases[0]
            draft_case = BenchmarkCase(
                suite_version_id=draft_only.id,
                stable_key=source_case.stable_key,
                title=source_case.title,
                category=source_case.category,
                radar_dimension=source_case.radar_dimension,
                difficulty=source_case.difficulty,
                question=source_case.question,
                reference_sql=source_case.reference_sql,
                required_ast_json=source_case.required_ast_json,
                comparison_json=source_case.comparison_json,
                weight=source_case.weight,
                sort_order=source_case.sort_order,
            )
            session.add(draft_case)
            await session.commit()
            return (
                draft_only_name,
                draft_only.id,
                draft_case.id,
                mixed_draft.id,
                published.suite.name,
            )

    with TestClient(app, base_url="http://127.0.0.1") as client:
        draft_name, draft_version_id, draft_case_id, mixed_draft_id, published_name = (
            asyncio.run(seed_drafts())
        )
        response = client.get("/api/suites")
        assert response.status_code == 200, response.text
        suites = response.json()
        assert draft_name not in {suite["name"] for suite in suites}
        published_suite = next(suite for suite in suites if suite["name"] == published_name)
        assert published_suite["name"] == published_name
        assert all(version["status"] == "published" for version in published_suite["versions"])
        assert mixed_draft_id not in {version["id"] for version in published_suite["versions"]}

        hidden_preview = client.get(
            f"/api/suite-versions/{draft_version_id}/prompt-preview?case_id={draft_case_id}"
        )
        assert hidden_preview.status_code == 404
        assert hidden_preview.json()["code"] == "suite_case_not_found"

        headers = csrf(client)
        removed_requests = [
            client.post("/api/suites", headers=headers, json={}),
            client.post("/api/suites/1/clone", headers=headers),
            client.patch(f"/api/suite-versions/{draft_version_id}", headers=headers, json={}),
            client.post(f"/api/suite-versions/{draft_version_id}/validate", headers=headers),
            client.post(f"/api/suite-versions/{draft_version_id}/publish", headers=headers),
            client.post(f"/api/suite-versions/{draft_version_id}/challenge-check", headers=headers),
        ]
        assert all(response.status_code in {404, 405} for response in removed_requests)

def test_cancelled_run_reaches_terminal_state(monkeypatch: Any) -> None:
    fixture = FixtureAdapter()
    monkeypatch.setitem(adapter_registry._adapters, "pi", fixture)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        headers = csrf(client)
        slow = create_profile(client, headers, "Slow", "pi", "slow-model")
        suite = client.get("/api/suites").json()[0]["versions"][0]
        created = client.post(
            "/api/runs",
            headers=headers,
            json={
                "suite_version_id": suite["id"],
                "model_profile_ids": [slow],
                "case_ids": [suite["cases"][0]["id"]],
                "attempts": 1,
            },
        )
        run_id = int(created.json()["id"])
        cancelled = client.post(f"/api/runs/{run_id}/cancel", headers=headers)
        assert cancelled.status_code == 200
        snapshot = wait_for_run(client, run_id)
        assert snapshot["status"] == "cancelled"
        history = client.get(f"/api/runs/{run_id}/events/history?limit=5000").json()["events"]
        assert history[-1]["event_type"] == "run.cancelled"


def test_preflight_failed_rerun_and_publication(monkeypatch: Any, tmp_path: Path) -> None:
    fixture = FixtureAdapter()
    monkeypatch.setitem(adapter_registry._adapters, "pi", fixture)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        headers = csrf(client)
        good = create_profile(client, headers, "Workflow good", "pi", "reference-model")
        bad = create_profile(client, headers, "Workflow bad", "pi", "always-fail")
        suite = client.get("/api/suites").json()[0]["versions"][0]
        case = suite["cases"][0]
        payload = {
            "suite_version_id": suite["id"],
            "model_profile_ids": [good, bad],
            "case_ids": [case["id"]],
            "attempts": 1,
        }
        before = {item["id"] for item in client.get("/api/runs").json()["runs"]}
        checked = client.post("/api/runs/preflight", headers=headers, json=payload)
        assert checked.status_code == 200, checked.text
        check = checked.json()
        assert check["ready"] is True
        assert check["total_calls"] == 2
        assert check["selected_case_count"] == 1
        assert len(check["models"]) == 2
        assert {item["id"] for item in client.get("/api/runs").json()["runs"]} == before


        created = client.post("/api/runs", headers=headers, json=payload)
        assert created.status_code == 200, created.text
        run_id = int(created.json()["id"])
        snapshot = wait_for_run(client, run_id)
        assert snapshot["status"] == "completed_with_errors"

        preview = client.get(f"/api/runs/{run_id}/publication-preview")
        assert preview.status_code == 200, preview.text
        preview_data = preview.json()
        assert preview_data["manifest_summary"]["case_run_count"] == 2
        assert "reference_sql" not in json.dumps(preview_data)
        stale = client.post(
            f"/api/runs/{run_id}/publication-export",
            headers=headers,
            json={"preview_digest": "0" * 64},
        )
        assert stale.status_code == 409
        assert stale.json()["code"] == "publication_preview_changed"
        exported = client.post(
            f"/api/runs/{run_id}/publication-export",
            headers=headers,
            json={"preview_digest": preview_data["summary_digest"]},
        )
        assert exported.status_code == 200, exported.text
        assert exported.headers["content-type"] == "application/zip"
        assert exported.headers["x-publication-status"] == "exported-not-published"
        archive_path = tmp_path / "publication.zip"
        archive_path.write_bytes(exported.content)
        with zipfile.ZipFile(archive_path) as archive:
            names = archive.namelist()
            assert preview_data["manifest_summary"]["file_count"] == len(names)
            package_index = json.loads(archive.read("index.json"))
            assert package_index["run_count"] == 1
            assert package_index["suite_count"] == 1
            assert all(f"run-{run_id:04d}" in name for name in names if name.startswith("runs/"))
            assert not any(name.endswith((".db", ".sqlite", ".sqlite3")) for name in names)

        successful = client.post(
            "/api/runs",
            headers=headers,
            json={**payload, "model_profile_ids": [good]},
        )
        successful_id = int(successful.json()["id"])
        assert wait_for_run(client, successful_id)["status"] == "completed"
        estimate_payload = {**payload, "model_profile_ids": [good]}
        assert (
            client.post("/api/runs/preflight", headers=headers, json=estimate_payload).json()[
                "estimate"
            ]["estimated_duration_seconds"]
            is not None
        )

        async def remove_generation_evidence() -> None:
            async with SessionLocal() as session:
                await session.execute(
                    update(CaseRun)
                    .where(
                        CaseRun.model_run_id.in_(
                            select(ModelRun.id).where(ModelRun.model_profile_id == good)
                        )
                    )
                    .values(generation_ms=None, execution_ms=10.0)
                )
                await session.commit()

        asyncio.run(remove_generation_evidence())
        estimate = client.post(
            "/api/runs/preflight", headers=headers, json=estimate_payload
        ).json()["estimate"]
        assert estimate["estimated_duration_seconds"] is None

        launched: list[int] = []
        monkeypatch.setattr(
            "backend.app.api.routes.benchmark_engine.launch",
            lambda launched_run_id: launched.append(launched_run_id),
        )
        empty = client.post(
            f"/api/runs/{successful_id}/rerun?scope=failed",
            headers=headers,
        )
        assert empty.status_code == 409
        assert empty.json()["code"] == "rerun_subset_empty"
        rerun = client.post(
            f"/api/runs/{run_id}/rerun?mode=exact&scope=failed",
            headers=headers,
        )
        assert rerun.status_code == 200, rerun.text
        rerun_id = int(rerun.json()["id"])
        assert launched == [rerun_id]
        subset = client.get(f"/api/runs/{rerun_id}").json()
        assert subset["source_run_id"] == run_id
        assert {len(model["cases"]) for model in subset["models"]} == {1}
        active = client.post(f"/api/runs/{rerun_id}/rerun?scope=failed", headers=headers)
        assert active.status_code == 409
        assert active.json()["code"] == "source_run_active"


def test_pi_only_creation_single_attempt_and_legacy_migration_gate() -> None:
    async def create_legacy_profile() -> int:
        async with SessionLocal() as session:
            profile = ModelProfile(
                name="Historical CLI",
                adapter_kind="codex_cli",
                model_id="historical-model",
                base_url=None,
                response_mode="text",
                api_key_ref=None,
                parameters_json={},
                pricing_json=None,
                enabled=True,
                health_status="healthy",
                health_details_json={"version": "historical"},
                last_checked_at=datetime.now(UTC),
                health_expires_at=datetime.now(UTC) + timedelta(hours=1),
            )
            session.add(profile)
            await session.commit()
            await session.refresh(profile)
            return profile.id

    with TestClient(app, base_url="http://127.0.0.1") as client:
        headers = csrf(client)
        rejected_adapter = client.post(
            "/api/model-profiles",
            headers=headers,
            json={
                "name": "Removed adapter",
                "adapter_kind": "codex_cli",
                "model_id": "model",
                "response_mode": "text",
                "parameters": {"provider": "openai"},
            },
        )
        assert rejected_adapter.status_code == 422
        unsupported = client.post(
            "/api/model-profiles",
            headers=headers,
            json={
                "name": "Unsupported parameter",
                "adapter_kind": "pi",
                "model_id": "model",
                "response_mode": "text",
                "parameters": {"provider": "openai", "unknown": True},
            },
        )
        assert unsupported.status_code == 422
        assert unsupported.json()["code"] == "invalid_pi_parameters"
        oauth_pricing = client.post(
            "/api/model-profiles",
            headers=headers,
            json={
                "name": "Subscription pricing",
                "adapter_kind": "pi",
                "model_id": "gpt-5",
                "response_mode": "text",
                "parameters": {"provider": "openai-codex", "auth_mode": "oauth"},
                "pricing": {
                    "currency": "USD",
                    "input_usd_per_million": 1,
                    "output_usd_per_million": 1,
                    "source": "invalid subscription estimate",
                    "effective_at": "2026-09-18",
                },
            },
        )
        assert oauth_pricing.status_code == 422
        assert oauth_pricing.json()["code"] == "invalid_pi_parameters"

        suite = client.get("/api/suites").json()[0]["versions"][0]
        rejected_attempts = client.post(
            "/api/runs/preflight",
            headers=headers,
            json={
                "suite_version_id": suite["id"],
                "model_profile_ids": [1],
                "attempts": 2,
            },
        )
        assert rejected_attempts.status_code == 422

        legacy_id = asyncio.run(create_legacy_profile())
        renamed = client.patch(
            f"/api/model-profiles/{legacy_id}",
            headers=headers,
            json={"name": "Historical renamed"},
        )
        assert renamed.status_code == 200
        structural = client.patch(
            f"/api/model-profiles/{legacy_id}",
            headers=headers,
            json={"model_id": "changed"},
        )
        assert structural.status_code == 409
        assert structural.json()["code"] == "legacy_profile_migration_required"

        checked = client.post(f"/api/model-profiles/{legacy_id}/check", headers=headers)
        assert checked.status_code == 200
        assert checked.json()["health_status"] == "unavailable"
        assert checked.json()["health_details"]["migration_required"] is True

        payload = {
            "suite_version_id": suite["id"],
            "model_profile_ids": [legacy_id],
            "attempts": 1,
        }
        preflight = client.post("/api/runs/preflight", headers=headers, json=payload)
        assert preflight.status_code == 200
        assert preflight.json()["ready"] is False
        assert "legacy_profile_migration_required" in {
            issue["code"] for issue in preflight.json()["issues"]
        }
        created = client.post("/api/runs", headers=headers, json=payload)
        assert created.status_code == 422
        assert created.json()["code"] == "legacy_profile_migration_required"


def test_pi_catalog_and_profile_definition_contract(pi_agent_dir: Path) -> None:
    (pi_agent_dir / "settings.json").write_text(
        json.dumps({"enabledModels": ["openai-codex/gpt-5.6-sol"]})
    )
    secret = "http-import-secret-must-not-leak"
    with TestClient(app, base_url="http://127.0.0.1") as client:
        headers = csrf(client)
        catalog = client.get("/api/pi/catalog")
        assert catalog.status_code == 200
        codex = next(
            model for model in catalog.json()["models"] if model["provider"] == "openai-codex"
        )
        assert codex["auth_modes"] == ["oauth"]
        assert "definition" not in codex

        preview = asyncio.run(
            preview_pi_import(
                {
                    "tools": [{"secret": secret}],
                    "providers": {
                        "local-http": {
                            "baseUrl": "http://127.0.0.1:11434/v1",
                            "api": "openai-completions",
                            "apiKey": f"!echo {secret}",
                            "models": [{"id": "qwen-http", "maxTokens": 4096}],
                        }
                    },
                }
            )
        )
        assert secret not in json.dumps(preview)
        imported = preview["models"][0]
        assert imported["supported"] is True
        created = client.post(
            "/api/model-profiles",
            headers=headers,
            json={
                "name": "Imported HTTP model",
                "adapter_kind": "pi",
                "model_id": imported["model_id"],
                "base_url": imported["base_url"],
                "response_mode": "text",
                "parameters": {
                    "provider": imported["provider"],
                    "auth_mode": "api_key",
                    "custom_model": imported["definition"],
                },
            },
        )
        assert created.status_code == 200
        assert created.json()["parameters"]["custom_model"] == imported["definition"]
        assert created.json()["secret_backend"] == "none"

        poisoned = {**imported["definition"], "apiKey": secret}
        rejected = client.post(
            "/api/model-profiles",
            headers=headers,
            json={
                "name": "Rejected imported model",
                "adapter_kind": "pi",
                "model_id": imported["model_id"],
                "base_url": imported["base_url"],
                "parameters": {
                    "provider": imported["provider"],
                    "custom_model": poisoned,
                },
            },
        )
        assert rejected.status_code == 422
        assert secret not in rejected.text


def test_pi_local_credential_profile_reuses_key_without_copying(pi_agent_dir: Path) -> None:
    (pi_agent_dir / "models.json").write_text(
        json.dumps(
            {
                "providers": {
                    "local-pi": {
                        "api": "openai-completions",
                        "baseUrl": "http://127.0.0.1:11434/v1",
                        "models": [{"id": "qwen-local", "maxTokens": 4096}],
                    }
                }
            }
        )
    )
    (pi_agent_dir / "settings.json").write_text(
        json.dumps({"enabledModels": ["local-pi/qwen-local"]})
    )
    (pi_agent_dir / "auth.json").write_text(
        json.dumps({"local-pi": {"type": "api_key", "key": "pi-local-secret"}})
    )
    with TestClient(app, base_url="http://127.0.0.1") as client:
        headers = csrf(client)
        catalog = client.get("/api/pi/catalog")
        assert catalog.status_code == 200
        entry = next(
            model for model in catalog.json()["models"] if model["provider"] == "local-pi"
        )
        credentials = client.get("/api/pi/credentials")
        assert credentials.json() == {"providers": [{"provider": "local-pi", "types": ["api_key"]}]}
        assert "pi-local-secret" not in credentials.text

        payload = {
            "name": "Pi 本机凭据模型",
            "adapter_kind": "pi",
            "model_id": entry["model_id"],
            "base_url": entry["base_url"],
            "parameters": {
                "provider": "local-pi",
                "auth_mode": "api_key",
                "custom_model": entry["definition"],
            },
        }
        created = client.post("/api/model-profiles", headers=headers, json=payload)
        assert created.status_code == 200, created.text
        profile = created.json()
        assert profile["has_secret"] is True and profile["secret_backend"] == "pi"
        assert "pi-local-secret" not in created.text

        checked = client.post(f"/api/model-profiles/{profile['id']}/check", headers=headers)
        assert checked.status_code == 200
        assert checked.json()["health_status"] == "healthy"
        assert checked.json()["health_details"]["credential_source"] == "pi_auth_file"

        overridden = client.post(
            "/api/model-profiles",
            headers=headers,
            json={**payload, "base_url": "https://proxy.example/v1"},
        )
        assert overridden.status_code == 422
        assert "pi-local-secret" not in overridden.text


def test_pi_credential_creation_requires_login_and_exact_endpoint(pi_agent_dir: Path) -> None:
    (pi_agent_dir / "auth.json").write_text(
        json.dumps({"kimi-coding": {"type": "api_key", "key": "pi-kimi-secret"}})
    )
    (pi_agent_dir / "settings.json").write_text(json.dumps({"enabledModels": ["kimi-coding/k3"]}))
    with TestClient(app, base_url="http://127.0.0.1") as client:
        headers = csrf(client)
        missing = client.post(
            "/api/model-profiles",
            headers=headers,
            json={
                "name": "无凭据模型",
                "adapter_kind": "pi",
                "model_id": "k3",
                "parameters": {"provider": "another-provider", "auth_mode": "api_key"},
            },
        )
        assert missing.status_code == 422
        assert "没有 another-provider 的 API Key" in missing.text

        catalog = client.get("/api/pi/catalog").json()
        kimi = next(model for model in catalog["models"] if model["provider"] == "kimi-coding")
        assert "definition" not in kimi
        request_body = {
            "name": "Kimi 本机凭据",
            "adapter_kind": "pi",
            "model_id": kimi["model_id"],
            "parameters": {"provider": "kimi-coding", "auth_mode": "api_key"},
        }
        overridden = client.post(
            "/api/model-profiles",
            headers=headers,
            json={**request_body, "base_url": "https://proxy.example/v1"},
        )
        assert overridden.status_code == 422
        assert "服务端地址" in overridden.text
        accepted = client.post(
            "/api/model-profiles",
            headers=headers,
            json={**request_body, "base_url": kimi["base_url"]},
        )
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["secret_backend"] == "pi"
