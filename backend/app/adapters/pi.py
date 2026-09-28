from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import signal
import tempfile
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from backend.app.adapters.base import (
    MAX_RAW_OUTPUT_BYTES,
    AdapterError,
    AdapterHealth,
    AdapterProfile,
    EventSink,
    GenerationResponse,
    parse_generation_output,
    provider_request_payload,
    safe_subprocess_env,
)
from backend.app.domain import GenerationRequest
from backend.app.security import redact_secrets

RUNTIME = Path(__file__).resolve().parents[3] / "runtime" / "pi"
POLICY = json.loads((RUNTIME / "policy.json").read_text())
PI_VERSION = json.loads((RUNTIME / "package.json").read_text())["dependencies"][
    "@earendil-works/pi-ai"
]
PI_CREDENTIAL_PREFIX = "pi-auth:"
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


class PiImportSource(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)
    format: Literal["pi-models-json"]
    pi_version: str = Field(alias="piVersion", min_length=1, max_length=50)


class PiOpenAICompletionsCompat(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)
    supports_store: bool | None = Field(default=None, alias="supportsStore")
    supports_developer_role: bool | None = Field(default=None, alias="supportsDeveloperRole")
    supports_reasoning_effort: bool | None = Field(default=None, alias="supportsReasoningEffort")


class PiCustomModelDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)
    kind: Literal["custom", "builtin_override"]
    provider: str = Field(pattern=r"^[a-z][a-z0-9-]*$", max_length=100)
    id: str = Field(min_length=1, max_length=300)
    name: str = Field(min_length=1, max_length=300)
    api: Literal[
        "openai-completions",
        "openai-responses",
        "openai-codex-responses",
        "anthropic-messages",
        "google-generative-ai",
    ]
    base_url: str = Field(alias="baseUrl", min_length=1, max_length=2000)
    reasoning: bool
    thinking_level_map: (
        dict[Literal["off", "minimal", "low", "medium", "high", "xhigh", "max"], str | None] | None
    ) = Field(default=None, alias="thinkingLevelMap")
    input: list[Literal["text", "image"]] = Field(min_length=1, max_length=2)
    context_window: int = Field(alias="contextWindow", ge=1, le=10_000_000)
    max_tokens: int = Field(alias="maxTokens", ge=1, le=1_000_000)
    compat: PiOpenAICompletionsCompat | None = None
    source: PiImportSource

    @field_validator("base_url")
    @classmethod
    def safe_base_url(cls, value: str) -> str:
        url = urlsplit(value)
        if (
            url.scheme not in {"http", "https"}
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise ValueError("导入模型 Base URL 必须是无内嵌凭证、查询参数或片段的 HTTP(S) 地址")
        return value

    @model_validator(mode="after")
    def supported_custom_protocol(self) -> PiCustomModelDefinition:
        if self.kind == "custom" and self.api == "openai-codex-responses":
            raise ValueError("Codex 订阅协议不能作为 models.json 自定义 provider 导入")
        if self.compat is not None and self.api != "openai-completions":
            raise ValueError("导入 compat 白名单仅适用于 openai-completions")
        return self


class PiParameters(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    provider: str = Field(pattern=r"^[a-z][a-z0-9-]*$", max_length=100)
    auth_mode: Literal["oauth", "api_key"] = "api_key"
    timeout_seconds: float = Field(default=180, gt=0, le=1800)
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, ge=1, le=128000)
    reasoning_effort: Literal["minimal", "low", "medium", "high", "xhigh", "max"] | None = None
    custom_model: PiCustomModelDefinition | None = None

    @model_validator(mode="after")
    def supported_subscription(self) -> PiParameters:
        if self.provider == "openai-codex":
            if self.auth_mode != "oauth":
                raise ValueError("openai-codex 使用订阅 OAuth，不使用 API Key")
            if self.max_tokens is not None:
                raise ValueError("Pi 的 Codex 订阅通道不发送 max_tokens；不能假装该限制已生效")
        return self


def _safe_validation_message(exc: ValidationError) -> str:
    issues = []
    for error in exc.errors(include_input=False, include_url=False):
        location = ".".join(str(part) for part in error["loc"]) or "parameters"
        issues.append(f"{location}: {error['type']}")
    return "Pi 参数校验失败（" + "; ".join(issues[:8]) + "）"


def validate_parameters(
    parameters: dict[str, Any],
    base_url: str | None,
    response_mode: str,
    model_id: str | None = None,
) -> dict[str, Any]:
    try:
        parsed = PiParameters.model_validate(parameters)
    except ValidationError as exc:
        raise ValueError(_safe_validation_message(exc)) from None
    if response_mode != "text":
        raise ValueError(
            "Pi 统一使用 text 通道，在固定提示中规定 JSON 输出，不采用厂商专属 JSON 模式"
        )
    if base_url:
        url = urlsplit(base_url)
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password:
            raise ValueError("Base URL 必须是无内嵌凭证的 HTTP(S) 地址")
        if url.query or url.fragment:
            raise ValueError("Base URL 不能包含查询参数或片段；凭证必须放入钥匙串")
        if parsed.auth_mode == "oauth" and not (
            parsed.custom_model and parsed.custom_model.kind == "builtin_override"
        ):
            raise ValueError("订阅 OAuth 不允许覆盖服务端地址")
    if parsed.custom_model:
        definition = parsed.custom_model
        if definition.source.pi_version != PI_VERSION:
            raise ValueError("导入模型 definition.source.piVersion 必须与锁定 Pi 版本一致")
        if definition.provider != parsed.provider:
            raise ValueError("导入模型 definition.provider 必须与 parameters.provider 一致")
        if model_id is not None and definition.id != model_id:
            raise ValueError("导入模型 definition.id 必须与 model_id 一致")
        if base_url != definition.base_url:
            raise ValueError("导入模型 definition.baseUrl 必须与 profile base_url 一致")
        if definition.kind == "custom" and parsed.auth_mode != "api_key":
            raise ValueError("导入的自定义 provider 仅支持单独配置 API Key")
    return parsed.model_dump(exclude_none=True, by_alias=True)


def validate_pi_profile(profile: AdapterProfile) -> PiParameters:
    if profile.adapter_kind != "pi":
        raise ValueError("旧接入仅供历史存证，请新建 Pi 模型配置")
    return PiParameters.model_validate(
        validate_parameters(
            profile.parameters, profile.base_url, profile.response_mode, profile.model_id
        )
    )


def _credential_reference(provider: str) -> str:
    return f"{PI_CREDENTIAL_PREFIX}{provider}"


def _is_loopback(base_url: str | None) -> bool:
    return urlsplit(base_url or "").hostname in _LOOPBACK_HOSTS


def _pi_auth_entries() -> dict[str, Any]:
    # Read only the Pi credential file. Never load settings, rules, sessions, or extensions.
    path = Path.home() / ".pi" / "agent" / "auth.json"
    if not path.is_file():
        return {}
    try:
        entries = json.loads(path.read_text())
    except (ValueError, OSError):
        return {}
    return entries if isinstance(entries, dict) else {}


def _pi_api_key(provider: str) -> str | None:
    entry = _pi_auth_entries().get(provider)
    if not isinstance(entry, dict) or entry.get("type") != "api_key":
        return None
    key = entry.get("key")
    return key if isinstance(key, str) and key else None


def _pi_login(provider: str) -> dict[str, Any] | None:
    entry = _pi_auth_entries().get(provider)
    if not isinstance(entry, dict) or entry.get("type") != "oauth":
        return None
    return {
        key: entry[key]
        for key in ("type", "access", "refresh", "expires", "accountId")
        if key in entry
    }


def _codex_login() -> dict[str, Any] | None:
    codex_auth = Path.home() / ".codex" / "auth.json"
    if not codex_auth.is_file():
        return None
    try:
        tokens = json.loads(codex_auth.read_text()).get("tokens", {})
        access, refresh = tokens.get("access_token"), tokens.get("refresh_token")
        if not isinstance(access, str) or not isinstance(refresh, str):
            return None
        encoded = access.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        return {
            "type": "oauth",
            "access": access,
            "refresh": refresh,
            "expires": float(claims.get("exp", 0)) * 1000,
            "accountId": tokens.get("account_id"),
        }
    except (ValueError, OSError, IndexError, TypeError):
        return None


def _stored_login(provider: str) -> tuple[dict[str, Any] | None, str | None]:
    # Read the login Pi (or an existing Codex login) already stores; never write or refresh.
    pi_login = _pi_login(provider)
    codex_login = _codex_login() if provider == "openai-codex" else None
    if codex_login and (
        pi_login is None or float(pi_login.get("expires", 0)) < float(codex_login["expires"])
    ):
        return codex_login, "codex_auth_file"
    if pi_login is None:
        return None, None
    return pi_login, "pi_auth_file"


def _has_login(provider: str, auth_mode: str) -> bool:
    if auth_mode == "oauth":
        return _stored_login(provider)[0] is not None
    return _pi_api_key(provider) is not None


async def list_pi_credentials() -> dict[str, Any]:
    # Presence only: provider ids and credential kinds, never credential values.
    def index() -> dict[str, Any]:
        entries = _pi_auth_entries()
        providers: dict[str, list[str]] = {}
        for provider, entry in entries.items():
            if not isinstance(entry, dict):
                continue
            kind = entry.get("type")
            if kind not in {"api_key", "oauth"}:
                continue
            field = "key" if kind == "api_key" else "access"
            if isinstance(entry.get(field), str) and entry[field]:
                providers.setdefault(str(provider), []).append(kind)
        if _codex_login() and "oauth" not in providers.get("openai-codex", []):
            providers.setdefault("openai-codex", []).append("oauth")
        return {
            "providers": [
                {"provider": provider, "types": types}
                for provider, types in sorted(providers.items())
            ]
        }

    return await asyncio.to_thread(index)


async def _reject_endpoint_override(provider: str, model_id: str, base_url: str | None) -> None:
    if not base_url:
        return
    catalog = await get_pi_catalog()
    entry = next(
        (
            model
            for model in catalog["models"]
            if model["provider"] == provider and model["model_id"] == model_id
        ),
        None,
    )
    if entry and entry["base_url"] and entry["base_url"] != base_url:
        raise AdapterError(
            "provider_auth_error", "使用 Pi 本机凭据时不能覆盖该 Provider 的服务端地址"
        )


async def pi_credential_reference(
    provider: str, model_id: str, base_url: str | None, auth_mode: str
) -> str | None:
    """Reference the credential Pi stores locally; 评测台不复制、不写入任何凭据。"""
    if not await asyncio.to_thread(_has_login, provider, auth_mode):
        if auth_mode == "api_key" and _is_loopback(base_url):
            return None
        if auth_mode == "api_key":
            detail = f"Pi 本机 auth.json 没有 {provider} 的 API Key"
        else:
            detail = f"Pi 本机 auth.json 没有 {provider} 的订阅登录"
        raise AdapterError("provider_auth_error", f"{detail}；请先在 Pi 中登录或配置，然后重新保存")
    await _reject_endpoint_override(provider, model_id, base_url)
    return _credential_reference(provider)


def _scrub(value: Any, credential: dict[str, Any]) -> Any:
    if isinstance(value, str):
        for key in ("key", "access", "refresh"):
            secret = credential.get(key)
            if isinstance(secret, str) and secret:
                value = value.replace(secret, "[REDACTED]")
        return redact_secrets(value)
    if isinstance(value, dict):
        return {key: _scrub(item, credential) for key, item in value.items()}
    if isinstance(value, list):
        return [_scrub(item, credential) for item in value]
    return value


class PiAdapter:
    def _api_key(self, profile: AdapterProfile, params: PiParameters) -> str:
        reference = profile.api_key_ref or ""
        if reference and not reference.startswith(PI_CREDENTIAL_PREFIX):
            raise AdapterError(
                "provider_auth_error",
                "该配置引用的是已移除的评测台凭据；请删除后从 Pi 已接入模型重新创建",
            )
        if reference and reference.removeprefix(PI_CREDENTIAL_PREFIX) != params.provider:
            raise AdapterError("provider_auth_error", "Pi 本机凭据引用与配置的 Provider 不一致")
        key = _pi_api_key(params.provider)
        if key:
            return key
        if _is_loopback(profile.base_url):
            return "local-no-auth"
        raise AdapterError(
            "provider_auth_error",
            f"Pi 本机 auth.json 没有 {params.provider} 的 API Key；"
            "请先在 Pi 中登录或配置，然后重新检查",
        )

    def _credential(
        self, profile: AdapterProfile, params: PiParameters
    ) -> tuple[dict[str, Any], str]:
        if params.auth_mode == "api_key":
            return {"type": "api_key", "key": self._api_key(profile, params)}, self._source(
                profile, params
            )
        credential, source = _stored_login(params.provider)
        if not isinstance(credential, dict) or not all(
            credential.get(key) for key in ("access", "refresh", "expires")
        ):
            raise AdapterError(
                "provider_auth_error",
                "未找到 Pi 的订阅登录：请先运行 Pi 登录（GPT 也可使用既有 Codex 登录），"
                "然后重新检查",
            )
        return credential, source or "pi_auth_file"

    def _source(self, profile: AdapterProfile, params: PiParameters) -> str:
        # Resolution already succeeded: Pi stored the key, or the loopback endpoint needs none.
        return "pi_auth_file" if _pi_api_key(params.provider) else "local_no_auth"

    async def _invoke(
        self,
        payload: dict[str, Any],
        cancel: asyncio.Event,
        timeout_seconds: float,
        emit: EventSink | None = None,
        profile: AdapterProfile | None = None,
        request: GenerationRequest | None = None,
    ) -> dict[str, Any]:
        node = shutil.which("node")
        if not node or not (RUNTIME / "node_modules" / "@earendil-works" / "pi-ai").exists():
            raise AdapterError(
                "profile_unavailable",
                "Pi 运行时未安装：pnpm --dir runtime/pi install --frozen-lockfile；"
                "需要 Node >=22.19",
            )
        if cancel.is_set():
            raise AdapterError("cancelled", "模型调用已取消")
        credential = payload.get("credential", {})
        with tempfile.TemporaryDirectory(prefix="sql-arena-pi-") as directory:
            process = await asyncio.create_subprocess_exec(
                node,
                str(RUNTIME / "bridge.mjs"),
                cwd=directory,
                env=safe_subprocess_env(),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
                limit=MAX_RAW_OUTPUT_BYTES + 1,
            )

            async def exchange() -> dict[str, Any]:
                assert process.stdin and process.stdout and process.stderr
                process.stdin.write(json.dumps(payload, ensure_ascii=False).encode())
                await process.stdin.drain()
                process.stdin.close()
                received = 0
                result: dict[str, Any] | None = None
                while line := await process.stdout.readline():
                    received += len(line)
                    if received > MAX_RAW_OUTPUT_BYTES:
                        raise AdapterError("provider_output_too_large", "Pi 输出超过 1 MiB")
                    try:
                        event = json.loads(line)
                    except ValueError as exc:
                        raise AdapterError(
                            "provider_protocol_error", "Pi 桥接输出不是合法 JSON"
                        ) from exc
                    if not isinstance(event, dict):
                        raise AdapterError("provider_protocol_error", "Pi 桥接事件结构无效")
                    event_type = event.get("type")
                    if event_type == "requested" and emit and profile and request:
                        await emit(
                            "provider.requested",
                            "info",
                            provider_request_payload(
                                profile,
                                request,
                                transport="pi",
                                invocation=_scrub(event["evidence"], credential),
                            ),
                        )
                    elif event_type == "delta" and emit:
                        await emit(
                            "provider.delta", "info", {"text": _scrub(event["text"], credential)}
                        )
                    elif event_type in {"result", "error"}:
                        result = event
                await process.wait()
                if result is None:
                    # Never echo process stderr: SDK/auth failures may contain credentials.
                    raise AdapterError(
                        "provider_runtime_error", "Pi 运行时未返回结果，请检查 Node 版本与依赖安装"
                    )
                if result.get("type") == "error":
                    error = result.get("error", {})
                    raise AdapterError(
                        str(error.get("code", "provider_error")),
                        str(_scrub(error.get("message", "Pi 调用失败"), credential)),
                        _scrub(result.get("evidence", {}), credential),
                    )
                if process.returncode:
                    raise AdapterError("provider_runtime_error", "Pi 运行时异常退出")
                return result

            async def drain_stderr() -> None:
                assert process.stderr
                while await process.stderr.read(8192):
                    pass

            worker = asyncio.create_task(exchange())
            stderr = asyncio.create_task(drain_stderr())
            cancelled = asyncio.create_task(cancel.wait())
            try:
                done, _ = await asyncio.wait(
                    {worker, cancelled},
                    timeout=timeout_seconds,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if worker in done:
                    return await worker
                if cancelled in done:
                    raise AdapterError("cancelled", "模型调用已取消")
                raise AdapterError("provider_timeout", f"Pi 调用超过 {timeout_seconds:g} 秒")
            finally:
                if process.returncode is None:
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                        await asyncio.wait_for(process.wait(), 2)
                    except (ProcessLookupError, TimeoutError):
                        if process.returncode is None:
                            os.killpg(process.pid, signal.SIGKILL)
                            await process.wait()
                for task in (worker, stderr, cancelled):
                    task.cancel()
                await asyncio.gather(worker, stderr, cancelled, return_exceptions=True)

    def _payload(
        self,
        profile: AdapterProfile,
        params: PiParameters,
        credential: dict[str, Any],
        operation: str,
    ) -> dict[str, Any]:
        return {
            "operation": operation,
            "model_id": profile.model_id,
            "base_url": profile.base_url,
            "parameters": params.model_dump(exclude_none=True, by_alias=True),
            "credential": credential,
        }

    async def check(self, profile: AdapterProfile) -> AdapterHealth:
        try:
            params = validate_pi_profile(profile)
            credential, source = await asyncio.to_thread(self._credential, profile, params)
            result = await self._invoke(
                self._payload(profile, params, credential, "check"), asyncio.Event(), 20
            )
            return AdapterHealth(
                status="healthy",
                message="Pi 本地配置就绪；未发送模型请求，实际模型权限在运行时验证",
                version=f"pi-ai {PI_VERSION}",
                details={**result["evidence"], "credential_source": source},
            )
        except (AdapterError, ValueError) as exc:
            return AdapterHealth(
                status="unavailable",
                message=str(exc),
                version=f"pi-ai {PI_VERSION}",
                details={"code": getattr(exc, "code", "profile_incompatible")},
            )

    async def generate(
        self,
        profile: AdapterProfile,
        request: GenerationRequest,
        emit: EventSink,
        cancel: asyncio.Event,
    ) -> GenerationResponse:
        params = validate_pi_profile(profile)
        credential, source = await asyncio.to_thread(self._credential, profile, params)
        payload = self._payload(profile, params, credential, "generate")
        payload.update(prompt=request.prompt, output_schema=request.output_schema)
        result = await self._invoke(payload, cancel, params.timeout_seconds, emit, profile, request)
        evidence = {
            **_scrub(result["evidence"], credential),
            "credential_source": source,
        }
        await emit(
            "provider.completed",
            "info",
            {
                "status": "completed",
                **evidence,
                "elapsed_ms": result["latency_ms"],
                "token_usage": result["token_usage"],
            },
        )
        raw = str(_scrub(result["raw_output"], credential))
        parsed, strict = parse_generation_output(raw)
        return GenerationResponse(
            raw_output=raw,
            parsed_output=parsed,
            resolved_model_id=None,
            token_usage=result["token_usage"],
            provider_request_id=result.get("provider_request_id"),
            latency_ms=result["latency_ms"],
            protocol_strict=strict,
        )


def _read_pi_model_file(filename: str) -> dict[str, Any]:
    path = Path.home() / ".pi" / "agent" / filename
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        raise AdapterError(
            "pi_config_unavailable", f"无法读取 Pi {filename}，请检查文件格式"
        ) from None
    if not isinstance(value, dict):
        raise AdapterError("pi_config_unavailable", f"Pi {filename} 必须是 JSON 对象")
    return value


async def get_pi_catalog() -> dict[str, Any]:
    # Read only the model selection and declarative definitions; never load agent code/auth.
    settings = await asyncio.to_thread(_read_pi_model_file, "settings.json")
    config = await asyncio.to_thread(_read_pi_model_file, "models.json")
    enabled = settings.get("enabledModels")
    if enabled is not None and (
        not isinstance(enabled, list) or any(not isinstance(item, str) for item in enabled)
    ):
        raise AdapterError("pi_config_unavailable", "Pi enabledModels 必须是模型标识数组")
    imported = (await preview_pi_import(config))["models"] if config else []
    if enabled is None:
        enabled = [f"{model['provider']}/{model['model_id']}" for model in imported]
        provider, model_id = settings.get("defaultProvider"), settings.get("defaultModel")
        if isinstance(provider, str) and isinstance(model_id, str):
            enabled.insert(0, f"{provider}/{model_id}")
    if not enabled:
        return {"version": PI_VERSION, "models": []}
    result = await PiAdapter()._invoke({"operation": "catalog"}, asyncio.Event(), 20)
    available = {f"{model['provider']}/{model['model_id']}": model for model in result["models"]}
    available.update({f"{model['provider']}/{model['model_id']}": model for model in imported})
    selected: dict[str, Any] = {}
    for pattern in enabled:
        # Pi selectors may carry a thinking level; it is not part of the model identity.
        identity, separator, level = pattern.rpartition(":")
        if separator and level in {"off", "minimal", "low", "medium", "high", "xhigh", "max"}:
            pattern = identity
        matches = [
            key
            for key, model in available.items()
            if fnmatchcase(key, pattern)
            or ("/" not in pattern and fnmatchcase(model["model_id"], pattern))
        ]
        for key in matches:
            selected[key] = available[key]
        if not matches and "/" in pattern and not any(char in pattern for char in "*?["):
            provider, model_id = pattern.split("/", 1)
            selected[pattern] = {
                "provider": provider,
                "model_id": model_id,
                "name": model_id,
                "api": "",
                "base_url": "",
                "context_window": 0,
                "max_tokens": 0,
                "reasoning_levels": [],
                "auth_modes": [],
                "supported": False,
                "unavailable_reason": (
                    "已在 Pi 启用，但定义不在内置目录或 models.json 中；"
                    "请显式导入模型定义，评测台不会加载 Pi 扩展"
                ),
            }
    return {"version": result["version"], "models": list(selected.values())}


async def preview_pi_import(config: dict[str, Any]) -> dict[str, Any]:
    result = await PiAdapter()._invoke(
        {"operation": "import-preview", "config": config}, asyncio.Event(), 20
    )
    return {key: value for key, value in result.items() if key != "type"}
