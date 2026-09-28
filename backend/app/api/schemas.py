from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class ErrorResponse(ApiModel):
    code: str
    message: str
    details: dict[str, Any]
    request_id: str


class TokenPricing(ApiModel):
    currency: Literal["USD"] = "USD"
    input_usd_per_million: float | None = Field(default=None, ge=0)
    cached_input_usd_per_million: float | None = Field(default=None, ge=0)
    cache_write_input_usd_per_million: float | None = Field(default=None, ge=0)
    output_usd_per_million: float | None = Field(default=None, ge=0)
    source: str = "manual"
    effective_at: str


class PiCatalogModel(ApiModel):
    provider: str
    model_id: str
    name: str
    api: str
    base_url: str
    context_window: int
    max_tokens: int
    reasoning_levels: list[str]
    auth_modes: list[Literal["api_key", "oauth"]]
    supported: bool
    unavailable_reason: str | None
    definition: dict[str, Any] | None = None


class PiCatalogOut(ApiModel):
    version: str
    models: list[PiCatalogModel]


class PiCredentialEntry(ApiModel):
    provider: str
    types: list[Literal["api_key", "oauth"]]


class PiCredentialsOut(ApiModel):
    providers: list[PiCredentialEntry]


class ModelProfileCreate(ApiModel):
    name: str
    adapter_kind: Literal["pi"]
    model_id: str
    base_url: str | None = None
    response_mode: Literal["text"] = "text"
    parameters: dict[str, Any] = Field(default_factory=dict)
    pricing: TokenPricing | None = None
    enabled: bool = True


class ModelProfilePatch(ApiModel):
    name: str | None = None
    model_id: str | None = None
    base_url: str | None = None
    response_mode: Literal["json_schema", "json_object", "text"] | None = None
    parameters: dict[str, Any] | None = None
    pricing: TokenPricing | None = None
    enabled: bool | None = None


class ModelProfileOut(ApiModel):
    id: int
    name: str
    adapter_kind: str
    model_id: str
    base_url: str | None
    response_mode: str
    parameters: dict[str, Any]
    pricing: TokenPricing | None
    enabled: bool
    has_secret: bool
    secret_backend: Literal["keyring", "environment", "pi", "none"]
    health_status: str
    health_details: dict[str, Any]
    last_checked_at: datetime | None
    health_expires_at: datetime | None
    created_at: datetime
    updated_at: datetime


class RunCreate(ApiModel):
    suite_version_id: int
    model_profile_ids: list[int] = Field(min_length=1, max_length=6)
    case_ids: list[int] | None = None
    attempts: Literal[1] = 1

    @model_validator(mode="after")
    def unique_models(self) -> RunCreate:
        if len(self.model_profile_ids) != len(set(self.model_profile_ids)):
            raise ValueError("model_profile_ids must be unique")
        return self


class RunCreated(ApiModel):
    id: int
    mode: Literal["single", "comparison"]
    status: str


class PublicationExportRequest(ApiModel):
    preview_digest: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")


class EventOut(ApiModel):
    seq: int
    event_type: str
    level: str
    created_at: datetime
    model_run_id: int | None
    case_run_id: int | None
    message: str
    payload: dict[str, Any]
