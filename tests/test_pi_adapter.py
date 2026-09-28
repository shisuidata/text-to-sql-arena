from __future__ import annotations

import asyncio
import base64
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from backend.app.adapters.base import AdapterError, AdapterProfile
from backend.app.adapters.pi import (
    PiAdapter,
    get_pi_catalog,
    list_pi_credentials,
    pi_credential_reference,
    preview_pi_import,
    validate_parameters,
    validate_pi_profile,
)
from backend.app.domain import GenerationOutput, GenerationRequest

ANSWER = {
    "plan": {
        "grain": "one row",
        "sources": [],
        "joins": [],
        "filters": [],
        "metrics": ["value"],
        "steps": ["select constant"],
        "risks": [],
    },
    "sql": "SELECT 1 AS value",
    "summary": "constant",
    "assumptions": [],
}

ProviderServer = tuple[str, list[dict[str, Any]], dict[str, str]]


@pytest.fixture
def provider_server() -> Iterator[ProviderServer]:
    requests: list[dict[str, Any]] = []
    mode = {"value": "answer"}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def do_POST(self) -> None:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(body)
            if mode["value"] == "rate_limit":
                self.send_response(429)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error":{"message":"rate limit audit-secret-value"}}')
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            if mode["value"] == "tool":
                delta = {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "tool-1",
                            "type": "function",
                            "function": {"name": "bash", "arguments": '{"command":"echo unsafe"}'},
                        }
                    ],
                }
                finish = "tool_calls"
            else:
                delta = {"role": "assistant", "content": json.dumps(ANSWER)}
                finish = "stop"
            for chunk in [
                {
                    "id": "response-1",
                    "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
                },
                {
                    "id": "response-1",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
                },
            ]:
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", requests, mode
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def profile(url: str) -> AdapterProfile:
    return AdapterProfile(
        id=1,
        name="local proof",
        adapter_kind="pi",
        model_id="local-proof",
        base_url=url,
        response_mode="text",
        api_key_ref="pi-auth:openai",
        parameters={"provider": "openai", "auth_mode": "api_key", "timeout_seconds": 10},
    )


@pytest.fixture
def pi_login(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("HOME", str(tmp_path))
    directory = tmp_path / ".pi" / "agent"
    directory.mkdir(parents=True)
    (directory / "auth.json").write_text(
        json.dumps({"openai": {"type": "api_key", "key": "audit-secret-value"}})
    )
    return directory


def request(prompt: str = "Select a constant") -> GenerationRequest:
    return GenerationRequest(
        case_key="local", prompt=prompt, output_schema=GenerationOutput.model_json_schema()
    )


@pytest.mark.asyncio
async def test_real_pi_calls_are_isolated_and_have_no_tools(
    provider_server: ProviderServer, pi_login: Path
) -> None:
    url, calls, _ = provider_server
    events = []

    async def emit(kind: str, level: str, payload: dict[str, Any]) -> None:
        events.append((kind, payload))

    adapter = PiAdapter()
    health = await adapter.check(profile(url))
    assert health.status == "healthy" and not calls
    first = await adapter.generate(
        profile(url), request("FIRST_CASE_SENTINEL"), emit, asyncio.Event()
    )
    second = await adapter.generate(
        profile(url), request("SECOND_CASE_SENTINEL"), emit, asyncio.Event()
    )
    assert first.parsed_output.sql == second.parsed_output.sql == "SELECT 1 AS value"
    assert len(calls) == 2
    assert all(not call.get("tools") for call in calls)
    assert len(calls[1]["messages"]) == 2
    assert "FIRST_CASE_SENTINEL" not in json.dumps(calls[1])
    assert calls[0]["messages"][0] == calls[1]["messages"][0]
    assert "audit-secret-value" not in json.dumps(events)
    completed = [payload for kind, payload in events if kind == "provider.completed"]
    assert all(
        item["generation_attempts"] == 1 and item["tool_calls_observed"] == 0 for item in completed
    )


@pytest.mark.asyncio
async def test_real_pi_does_not_retry_rate_limits_or_leak_credentials(
    provider_server: ProviderServer, pi_login: Path
) -> None:
    url, calls, mode = provider_server
    mode["value"] = "rate_limit"

    async def emit(*args: Any) -> None:
        pass

    with pytest.raises(AdapterError) as caught:
        await PiAdapter().generate(profile(url), request(), emit, asyncio.Event())
    assert len(calls) == 1
    assert caught.value.details["generation_attempts"] == 1
    assert "audit-secret-value" not in str(caught.value)


@pytest.mark.asyncio
async def test_real_pi_refuses_tool_calls_without_continuation(
    provider_server: ProviderServer, pi_login: Path
) -> None:
    url, calls, mode = provider_server
    mode["value"] = "tool"

    async def emit(*args: Any) -> None:
        pass

    with pytest.raises(AdapterError) as caught:
        await PiAdapter().generate(profile(url), request(), emit, asyncio.Event())
    assert caught.value.code == "adapter_policy_violation"
    assert len(calls) == 1
    assert caught.value.details["tool_calls_observed"] >= 1


@pytest.mark.asyncio
async def test_oauth_login_is_read_only_and_expiry_defers_to_pi(pi_agent_dir: Path) -> None:
    pi_file = pi_agent_dir / "auth.json"
    pi_file.write_text(
        json.dumps(
            {
                "openai-codex": {
                    "type": "oauth",
                    "access": "pi-access",
                    "refresh": "pi-refresh",
                    "expires": 1000,
                }
            }
        )
    )
    source_before = pi_file.read_bytes()
    oauth_profile = AdapterProfile(
        id=1,
        name="OAuth",
        adapter_kind="pi",
        model_id="gpt-5.6-luna",
        response_mode="text",
        api_key_ref="pi-auth:openai-codex",
        parameters={"provider": "openai-codex", "auth_mode": "oauth"},
    )
    health = await PiAdapter().check(oauth_profile)
    assert health.status == "healthy"
    assert health.details["credential_source"] == "pi_auth_file"
    assert "pi-access" not in json.dumps(health.details)
    assert pi_file.read_bytes() == source_before

    claims = base64.urlsafe_b64encode(b'{"exp":3}').decode().rstrip("=")
    codex_file = pi_agent_dir.parent.parent / ".codex" / "auth.json"
    codex_file.parent.mkdir()
    codex_file.write_text(
        json.dumps(
            {
                "tokens": {
                    "access_token": f"header.{claims}.signature",
                    "refresh_token": "codex-refresh",
                    "account_id": "account",
                }
            }
        )
    )
    codex_before = codex_file.read_bytes()
    preferred = await PiAdapter().check(oauth_profile)
    assert preferred.status == "healthy"
    assert preferred.details["credential_source"] == "codex_auth_file"
    assert codex_file.read_bytes() == codex_before
    assert pi_file.read_bytes() == source_before

    pi_file.write_text(
        json.dumps(
            {
                "openai-codex": {
                    "type": "oauth",
                    "access": "pi-access",
                    "refresh": "pi-refresh",
                    "expires": 1000,
                }
            }
        )
    )
    codex_file.unlink()
    codex_file.parent.rmdir()

    async def emit(*args: Any) -> None:
        pass

    with pytest.raises(AdapterError) as caught:
        await PiAdapter().generate(oauth_profile, request(), emit, asyncio.Event())
    assert "运行 Pi" in str(caught.value)
    assert caught.value.code == "provider_auth_error"


@pytest.mark.asyncio
async def test_catalog_and_import_preview_are_credential_blind(pi_agent_dir: Path) -> None:
    (pi_agent_dir / "settings.json").write_text(
        json.dumps({"enabledModels": ["openai-codex/gpt-5.6-sol", "openai/gpt-4o"]})
    )
    catalog = await get_pi_catalog()
    codex = next(model for model in catalog["models"] if model["provider"] == "openai-codex")
    assert catalog["version"] == "0.85.1"
    assert codex["api"] == "openai-codex-responses"
    assert codex["auth_modes"] == ["oauth"]

    secret = "must-not-leak-import-secret"
    preview = await preview_pi_import(
        {
            "prompt": secret,
            "providers": {
                "local-safe": {
                    "baseUrl": "http://127.0.0.1:11434/v1",
                    "api": "openai-completions",
                    "apiKey": f"!echo {secret}",
                    "headers": {"Authorization": f"Bearer {secret}"},
                    "models": [{"id": "qwen-local", "contextWindow": 32768}],
                }
            },
        }
    )
    rendered = json.dumps(preview, ensure_ascii=False)
    assert secret not in rendered
    assert preview["models"][0]["supported"] is False
    assert "definition" not in preview["models"][0]
    assert any("apiKey" in warning and "另行配置凭据" in warning for warning in preview["warnings"])
    assert any("headers" in warning for warning in preview["warnings"])
    assert any("固定提示" in warning for warning in preview["warnings"])

    builtin_id = next(
        model["model_id"]
        for model in catalog["models"]
        if model["provider"] == "openai" and model["supported"]
    )
    overridden = await preview_pi_import(
        {
            "providers": {
                "openai": {
                    "modelOverrides": {builtin_id: {"name": "Audited override", "maxTokens": 1234}}
                }
            }
        }
    )
    assert len(overridden["models"]) == 1
    assert overridden["models"][0]["name"] == "Audited override"
    assert overridden["models"][0]["max_tokens"] == 1234
    assert overridden["models"][0]["definition"]["kind"] == "builtin_override"


@pytest.mark.asyncio
async def test_catalog_follows_local_selection_without_full_directory_fallback(
    pi_agent_dir: Path,
) -> None:
    assert (await get_pi_catalog())["models"] == []
    (pi_agent_dir / "models.json").write_text(
        json.dumps(
            {
                "providers": {
                    "local": {
                        "api": "openai-completions",
                        "baseUrl": "http://localhost:11434/v1",
                        "apiKey": "!do-not-execute-secret",
                        "models": [{"id": "chosen"}, {"id": "hidden"}],
                    },
                    "openai-codex": {"modelOverrides": {"gpt-5.6-sol": {"maxTokens": 1234}}},
                }
            }
        )
    )
    settings_file = pi_agent_dir / "settings.json"
    settings_file.write_text(
        json.dumps(
            {
                "enabledModels": [
                    "openai-codex/gpt-5.6-sol:high",
                    "local/chosen",
                    "extension/model",
                    "local/chosen",
                ]
            }
        )
    )
    catalog = await get_pi_catalog()
    assert [f"{m['provider']}/{m['model_id']}" for m in catalog["models"]] == [
        "openai-codex/gpt-5.6-sol",
        "local/chosen",
        "extension/model",
    ]
    assert catalog["models"][0]["max_tokens"] == 1234
    custom = catalog["models"][1]
    assert custom["supported"] is True
    validate_parameters(
        {"provider": "local", "custom_model": custom["definition"]},
        custom["base_url"],
        "text",
        "chosen",
    )
    assert catalog["models"][2]["supported"] is False
    assert "definition" not in catalog["models"][2]
    assert "do-not-execute-secret" not in json.dumps(catalog)
    settings_file.write_text(json.dumps({"enabledModels": ["local/ch*"]}))
    assert [m["model_id"] for m in (await get_pi_catalog())["models"]] == ["chosen"]
    settings_file.write_text(
        json.dumps(
            {"enabledModels": [], "defaultProvider": "openai-codex", "defaultModel": "gpt-5.6-sol"}
        )
    )
    assert (await get_pi_catalog())["models"] == []
    settings_file.write_text("{invalid-json-secret")
    with pytest.raises(AdapterError) as caught:
        await get_pi_catalog()
    assert "invalid-json-secret" not in str(caught.value)


def test_imported_definition_validation_never_echoes_secret_input() -> None:
    secret = "definition-secret-must-not-leak"
    definition = {
        "kind": "custom",
        "provider": "local-safe",
        "id": "qwen-local",
        "name": "Qwen Local",
        "api": "openai-completions",
        "baseUrl": "https://user:password@example.com/v1",
        "reasoning": False,
        "input": ["text"],
        "contextWindow": 32768,
        "maxTokens": 4096,
        "source": {"format": "pi-models-json", "piVersion": "0.85.1"},
        "apiKey": secret,
    }
    with pytest.raises(ValueError) as caught:
        validate_parameters(
            {"provider": "local-safe", "custom_model": definition},
            "https://example.com/v1",
            "text",
            "qwen-local",
        )
    assert secret not in str(caught.value)
    assert "apiKey" in str(caught.value)


@pytest.mark.asyncio
async def test_imported_model_uses_pi_provider_without_definition_on_wire(
    provider_server: ProviderServer, pi_login: Path
) -> None:
    url, calls, _ = provider_server
    (pi_login / "auth.json").write_text(
        json.dumps({"local-import": {"type": "api_key", "key": "audit-secret-value"}})
    )
    preview = await preview_pi_import(
        {
            "providers": {
                "local-import": {
                    "baseUrl": url,
                    "api": "openai-completions",
                    "models": [
                        {
                            "id": "imported-proof",
                            "maxTokens": 4096,
                            "compat": {
                                "supportsStore": False,
                                "supportsDeveloperRole": False,
                                "supportsReasoningEffort": False,
                            },
                        }
                    ],
                }
            }
        }
    )
    imported = preview["models"][0]
    assert imported["supported"] is True
    assert imported["definition"]["compat"] == {
        "supportsStore": False,
        "supportsDeveloperRole": False,
        "supportsReasoningEffort": False,
    }
    imported_profile = AdapterProfile(
        id=2,
        name="imported proof",
        adapter_kind="pi",
        model_id=imported["model_id"],
        base_url=imported["base_url"],
        response_mode="text",
        api_key_ref="pi-auth:local-import",
        parameters={
            "provider": imported["provider"],
            "auth_mode": "api_key",
            "timeout_seconds": 10,
            "custom_model": imported["definition"],
        },
    )
    events: list[tuple[str, dict[str, Any]]] = []

    async def emit(kind: str, level: str, payload: dict[str, Any]) -> None:
        events.append((kind, payload))

    result = await PiAdapter().generate(
        imported_profile, request("IMPORTED_MODEL_SENTINEL"), emit, asyncio.Event()
    )
    assert result.parsed_output.sql == "SELECT 1 AS value"
    assert len(calls) == 1
    requested = next(payload for kind, payload in events if kind == "provider.requested")
    invocation = requested["invocation"]
    assert invocation["model_identity_source"] == "pi_models_json_import_preview"
    assert "custom_model" not in invocation["effective_parameters"]
    assert "custom_model" not in json.dumps(invocation["wire_payload"])
    assert invocation["imported_definition_source"]["format"] == "pi-models-json"


def _pi_local_credential_setup(pi_agent_dir: Path, key: str = "pi-stored-secret") -> None:
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
        json.dumps({"local-pi": {"type": "api_key", "key": key}})
    )


@pytest.mark.asyncio
async def test_pi_local_credential_is_referenced_without_copying(pi_agent_dir: Path) -> None:
    _pi_local_credential_setup(pi_agent_dir)
    reference = await pi_credential_reference(
        "local-pi", "qwen-local", "http://127.0.0.1:11434/v1", "api_key"
    )
    assert reference == "pi-auth:local-pi"
    local = AdapterProfile(
        id=3,
        name="pi local credential",
        adapter_kind="pi",
        model_id="qwen-local",
        base_url="http://127.0.0.1:11434/v1",
        response_mode="text",
        api_key_ref=reference,
        parameters={"provider": "local-pi", "auth_mode": "api_key", "timeout_seconds": 10},
    )
    credential, source = PiAdapter()._credential(local, validate_pi_profile(local))
    assert credential == {"type": "api_key", "key": "pi-stored-secret"}
    assert source == "pi_auth_file"
    health = await PiAdapter().check(local)
    assert health.status == "healthy"
    assert health.details["credential_source"] == "pi_auth_file"
    assert "pi-stored-secret" not in json.dumps(health.details)

    mismatched = local.model_copy(
        update={"parameters": {**local.parameters, "provider": "other-provider"}}
    )
    with pytest.raises(AdapterError) as caught:
        PiAdapter()._credential(mismatched, validate_pi_profile(mismatched))
    assert "Provider 不一致" in str(caught.value)

    legacy = local.model_copy(update={"api_key_ref": "env:PI_AUDIT_KEY"})
    with pytest.raises(AdapterError) as removed:
        PiAdapter()._credential(legacy, validate_pi_profile(legacy))
    assert "已移除的评测台凭据" in str(removed.value)


@pytest.mark.asyncio
async def test_pi_credential_reference_requires_login_and_exact_endpoint(
    pi_agent_dir: Path,
) -> None:
    _pi_local_credential_setup(pi_agent_dir)
    with pytest.raises(AdapterError) as unkeyed:
        await pi_credential_reference("kimi-coding", "k3", None, "api_key")
    assert "没有 kimi-coding 的 API Key" in str(unkeyed.value)
    with pytest.raises(AdapterError) as missing_login:
        await pi_credential_reference("openai-codex", "gpt-5.6-sol", None, "oauth")
    assert "订阅登录" in str(missing_login.value)
    with pytest.raises(AdapterError) as overridden:
        await pi_credential_reference(
            "local-pi", "qwen-local", "https://proxy.example/v1", "api_key"
        )
    assert "服务端地址" in str(overridden.value)
    assert (
        await pi_credential_reference(
            "local-pi", "qwen-local", "http://127.0.0.1:11434/v1", "api_key"
        )
        == "pi-auth:local-pi"
    )


@pytest.mark.asyncio
async def test_loopback_endpoint_without_stored_key_needs_no_credential(pi_agent_dir: Path) -> None:
    (pi_agent_dir / "auth.json").write_text(json.dumps({}))
    assert (
        await pi_credential_reference(
            "ollama", "local-model", "http://127.0.0.1:11434/v1", "api_key"
        )
        is None
    )
    loopback = AdapterProfile(
        id=4,
        name="loopback",
        adapter_kind="pi",
        model_id="local-model",
        base_url="http://127.0.0.1:11434/v1",
        response_mode="text",
        api_key_ref=None,
        parameters={"provider": "ollama", "auth_mode": "api_key", "timeout_seconds": 10},
    )
    credential, source = PiAdapter()._credential(loopback, validate_pi_profile(loopback))
    assert credential == {"type": "api_key", "key": "local-no-auth"}
    assert source == "local_no_auth"
    with pytest.raises(AdapterError) as remote:
        await pi_credential_reference("deepseek-official", "deepseek-v4-pro", None, "api_key")
    assert "没有 deepseek-official 的 API Key" in str(remote.value)


@pytest.mark.asyncio
async def test_pi_credentials_listing_is_presence_only(pi_agent_dir: Path) -> None:
    _pi_local_credential_setup(pi_agent_dir, key="listing-secret-value")
    (pi_agent_dir / "auth.json").write_text(
        json.dumps(
            {
                "local-pi": {"type": "api_key", "key": "listing-secret-value"},
                "subscription": {"type": "oauth", "access": "listing-oauth-value"},
                "empty": {"type": "api_key"},
            }
        )
    )
    listing = await list_pi_credentials()
    assert listing == {
        "providers": [
            {"provider": "local-pi", "types": ["api_key"]},
            {"provider": "subscription", "types": ["oauth"]},
        ]
    }
    assert "listing-secret-value" not in json.dumps(listing)
    assert "listing-oauth-value" not in json.dumps(listing)

    claims = base64.urlsafe_b64encode(b'{"exp":3}').decode().rstrip("=")
    codex_file = pi_agent_dir.parent.parent / ".codex" / "auth.json"
    codex_file.parent.mkdir()
    codex_file.write_text(
        json.dumps(
            {
                "tokens": {
                    "access_token": f"header.{claims}.signature",
                    "refresh_token": "codex-refresh",
                    "account_id": "account",
                }
            }
        )
    )
    assert (await list_pi_credentials())["providers"] == [
        {"provider": "local-pi", "types": ["api_key"]},
        {"provider": "openai-codex", "types": ["oauth"]},
        {"provider": "subscription", "types": ["oauth"]},
    ]


@pytest.mark.asyncio
async def test_import_preview_rejects_unsafe_entries_without_echoing_secrets() -> None:
    secret = "preview-url-credential-must-not-leak"
    providers = [
        {"models": [{"id": "missing-api"}]},
        {
            "api": "openai-completions",
            "baseUrl": f"https://user:{secret}@example.invalid/v1",
            "models": [{"id": "unsafe-url"}],
        },
        {
            "api": "openai-completions",
            "baseUrl": "http://localhost:11434/v1",
            "models": [{"id": "invalid-input", "input": {"apiKey": secret}}],
        },
    ]
    for provider in providers:
        preview = await preview_pi_import({"providers": {"local": provider}})
        rendered = json.dumps(preview, ensure_ascii=False)
        assert secret not in rendered
        entry = preview["models"][0]
        assert entry["supported"] is False
        assert "definition" not in entry
        assert entry["unavailable_reason"]
