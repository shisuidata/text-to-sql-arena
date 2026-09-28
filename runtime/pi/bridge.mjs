import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createProvider, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import * as anthropicMessages from "@earendil-works/pi-ai/api/anthropic-messages";
import * as googleGenerativeAi from "@earendil-works/pi-ai/api/google-generative-ai";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import * as openaiResponses from "@earendil-works/pi-ai/api/openai-responses";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const installed = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"))), "../package.json"), "utf8"));
const policy = JSON.parse(readFileSync(resolve(root, "policy.json"), "utf8"));
const hash = (text) => createHash("sha256").update(text).digest("hex");
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reject = (code, message) => { throw Object.assign(new Error(message), { code }); };
const supportedApis = new Set(["openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages", "google-generative-ai"]);
const importApis = new Map([
  ["openai-completions", openaiCompletions],
  ["openai-responses", openaiResponses],
  ["anthropic-messages", anthropicMessages],
  ["google-generative-ai", googleGenerativeAi],
]);
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
let secretValues = [];
let evidence = {};

function safe(value) {
  if (typeof value === "string") {
    for (const secret of secretValues) value = value.replaceAll(secret, "[REDACTED]");
    return value;
  }
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(authorization|api_?key|access|refresh|token|secret)$/i.test(k) ? "[REDACTED]" : safe(v)]));
  return value;
}

function isolatedBuiltinModels(options = {}) {
  return builtinModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
    credentials: options.credentials ?? {
      read: async () => undefined,
      list: async () => [],
      modify: async () => reject("provider_auth_error", "目录操作不能修改认证信息"),
      delete: async () => reject("provider_auth_error", "目录操作不能删除认证信息"),
    },
  });
}

function authModes(provider) {
  const modes = [];
  if (provider?.auth?.apiKey) modes.push("api_key");
  if (provider?.auth?.oauth) modes.push("oauth");
  return modes;
}

function unsupportedReason(model, modes, extra) {
  if (extra) return extra;
  if (!Array.isArray(model.input) || !model.input.includes("text")) return "该模型不是有效的文本输入模型";
  if (!supportedApis.has(model.api)) return "该 Pi 协议缺失或尚不满足单次无工具审计合同";
  if (!modes.length) return "该 provider 没有 bridge 可用的 API Key 或 OAuth 认证模式";
  return null;
}

function catalogEntry(model, provider, definition, extraReason = null, importedAuthModes = null) {
  const modes = importedAuthModes ?? (definition?.kind === "custom" ? ["api_key"] : authModes(provider));
  const unavailableReason = unsupportedReason(model, modes, extraReason);
  const supported = unavailableReason === null;
  const contextWindow = Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : 0;
  const maxTokens = Number.isInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : 0;
  return {
    provider: typeof model.provider === "string" ? model.provider : "",
    model_id: typeof model.id === "string" ? model.id : "",
    name: typeof model.name === "string" ? model.name : "",
    api: supportedApis.has(model.api) ? model.api : "",
    base_url: validUrl(model.baseUrl) ? model.baseUrl : "",
    context_window: contextWindow,
    max_tokens: maxTokens,
    reasoning_levels: supported && model.reasoning === true ? getSupportedThinkingLevels(model).filter((level) => level !== "off") : [],
    auth_modes: modes,
    supported,
    unavailable_reason: unavailableReason,
    ...(supported && definition ? { definition } : {}),
  };
}

function catalogResult() {
  const models = isolatedBuiltinModels();
  return {
    type: "result",
    version: installed.version,
    models: models.getModels().map((model) => catalogEntry(model, models.getProvider(model.provider))),
  };
}

function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function validUrl(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
function warnUnknown(warnings, path, value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) warnings.push(`${path} 含 ${unknown.length} 个安全导入白名单之外的字段，已忽略`);
  return unknown;
}
function safeThinkingMap(value) {
  if (!object(value)) return undefined;
  const result = {};
  for (const [key, mapped] of Object.entries(value)) {
    if (thinkingLevels.has(key) && (mapped === null || typeof mapped === "string")) result[key] = mapped;
  }
  return result;
}
function mergeThinking(base, override) {
  return override ? { ...(base ?? {}), ...safeThinkingMap(override) } : base;
}
const safeCompatKeys = new Set(["supportsStore", "supportsDeveloperRole", "supportsReasoningEffort"]);
function parseCompat(value) {
  if (value === undefined) return { value: undefined, error: null };
  if (!object(value)) return { value: undefined, error: "compat 必须是对象" };
  const unknown = Object.keys(value).filter((key) => !safeCompatKeys.has(key));
  if (unknown.length) return { value: undefined, error: "compat 包含安全白名单之外的字段" };
  if (Object.values(value).some((item) => typeof item !== "boolean")) {
    return { value: undefined, error: "compat 白名单字段必须是布尔值" };
  }
  return { value: { ...value }, error: null };
}
function safeDefinition(model, kind, compat) {
  return {
    kind,
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(compat && Object.keys(compat).length ? { compat } : {}),
    source: { format: "pi-models-json", piVersion: installed.version },
  };
}
function defaultsFor(models, id, api) {
  return models.find((model) => model.id === id)
    ?? (api ? models.find((model) => model.api === api) : undefined)
    ?? models.find((model) => model.api === "openai-completions")
    ?? models[0];
}
function applyOverride(model, override) {
  return {
    ...model,
    name: typeof override.name === "string" && override.name ? override.name : model.name,
    reasoning: typeof override.reasoning === "boolean" ? override.reasoning : model.reasoning,
    thinkingLevelMap: mergeThinking(model.thinkingLevelMap, override.thinkingLevelMap),
    input: Array.isArray(override.input) ? override.input : model.input,
    contextWindow: typeof override.contextWindow === "number" ? override.contextWindow : model.contextWindow,
    maxTokens: typeof override.maxTokens === "number" ? override.maxTokens : model.maxTokens,
  };
}

function importPreview(config) {
  if (!object(config) || !object(config.providers)) reject("invalid_pi_import", "配置必须是已解析的 Pi models.json 对象，且包含 providers 对象");
  const warnings = [];
  warnUnknown(warnings, "root", config, new Set(["providers"]));
  const builtins = isolatedBuiltinModels();
  const entries = [];
  const providerAllowed = new Set(["name", "baseUrl", "apiKey", "api", "oauth", "headers", "compat", "authHeader", "models", "modelOverrides"]);
  const modelAllowed = new Set(["id", "name", "api", "baseUrl", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "samplingParams", "headers", "compat"]);
  const overrideAllowed = new Set(["name", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "samplingParams", "headers", "compat"]);
  for (const [providerId, providerConfig] of Object.entries(config.providers)) {
    if (!/^[a-z][a-z0-9-]{0,99}$/.test(providerId) || !object(providerConfig)) {
      warnings.push(`providers.${providerId} 已忽略：provider id 或配置结构无效`);
      continue;
    }
    const providerUnknown = warnUnknown(warnings, `providers.${providerId}`, providerConfig, providerAllowed);
    const baseProvider = builtins.getProvider(providerId);
    const baseModels = [...builtins.getModels(providerId)];
    const providerUnsafe = [];
    const providerCompat = parseCompat(providerConfig.compat);
    if (providerUnknown.length) providerUnsafe.push("存在安全导入白名单之外的 provider 字段");
    if (own(providerConfig, "apiKey")) warnings.push(`providers.${providerId}.apiKey 已忽略：请在评测台另行配置凭据；不会执行命令、展开环境变量或保存字面密钥`);
    if (own(providerConfig, "headers")) providerUnsafe.push("自定义 headers 可能包含秘密且 bridge 不会导入");
    if (providerCompat.error) providerUnsafe.push(providerCompat.error);
    if (providerConfig.authHeader === true) providerUnsafe.push("authHeader 自定义认证语义暂不支持");
    if (own(providerConfig, "oauth")) providerUnsafe.push("models.json 动态 OAuth 配置暂不支持");
    const providerBaseUrl = providerConfig.baseUrl;
    if (providerBaseUrl !== undefined && !validUrl(providerBaseUrl)) providerUnsafe.push("baseUrl 必须是无凭据、查询参数或片段的 HTTP(S) 地址");
    for (const reason of providerUnsafe) warnings.push(`providers.${providerId}: ${reason}`);
    const configuredModels = Array.isArray(providerConfig.models) ? providerConfig.models : [];
    if (own(providerConfig, "models") && !Array.isArray(providerConfig.models)) warnings.push(`providers.${providerId}.models 已忽略：必须是数组`);
    const produced = new Map();
    for (let index = 0; index < configuredModels.length; index += 1) {
      const item = configuredModels[index];
      const path = `providers.${providerId}.models[${index}]`;
      if (!object(item) || typeof item.id !== "string" || !item.id) { warnings.push(`${path} 已忽略：id 必须是非空字符串`); continue; }
      const modelUnknown = warnUnknown(warnings, path, item, modelAllowed);
      const defaults = defaultsFor(baseModels, item.id, item.api ?? providerConfig.api);
      const api = item.api ?? providerConfig.api ?? defaults?.api;
      const baseUrl = item.baseUrl ?? providerBaseUrl ?? defaults?.baseUrl;
      let reason = providerUnsafe[0] ?? null;
      const modelCompat = parseCompat(item.compat);
      const importedCompat = { ...(providerCompat.value ?? {}), ...(modelCompat.value ?? {}) };
      if (!importApis.has(api)) reason ??= "自定义模型协议缺失或不受安全导入支持";
      if (modelUnknown.length) reason ??= "存在安全导入白名单之外的模型字段";
      if (own(item, "reasoning") && typeof item.reasoning !== "boolean") reason ??= "reasoning 必须是布尔值";
      if (own(item, "thinkingLevelMap") && !object(item.thinkingLevelMap)) reason ??= "thinkingLevelMap 必须是对象";
      if (own(item, "contextWindow") && typeof item.contextWindow !== "number") reason ??= "contextWindow 必须是数字";
      if (own(item, "maxTokens") && typeof item.maxTokens !== "number") reason ??= "maxTokens 必须是数字";
      if (!validUrl(baseUrl)) reason ??= "模型缺少安全的 baseUrl";
      if (own(item, "headers")) reason ??= "模型 headers 可能包含秘密且 bridge 不会导入";
      if (own(item, "samplingParams")) reason ??= "samplingParams 会逐字段覆盖 wire 请求，安全导入暂不支持";
      if (modelCompat.error) reason ??= modelCompat.error;
      if (Object.keys(importedCompat).length && api !== "openai-completions") reason ??= "该 compat 白名单仅适用于 openai-completions";
      if (own(item, "cost")) warnings.push(`${path}.cost 已忽略：目录能力不会自动应用价格`);
      for (const field of ["headers", "samplingParams"]) if (own(item, field)) warnings.push(`${path}.${field} 已忽略：不能安全保留其请求语义`);
      const input = item.input ?? ["text"];
      if (!Array.isArray(input) || input.some((kind) => !["text", "image"].includes(kind))) reason ??= "input 仅允许 text/image 数组";
      if (typeof item.contextWindow === "number" && (!Number.isInteger(item.contextWindow) || item.contextWindow <= 0)) reason ??= "contextWindow 必须是正整数";
      if (typeof item.maxTokens === "number" && (!Number.isInteger(item.maxTokens) || item.maxTokens <= 0)) reason ??= "maxTokens 必须是正整数";
      const model = {
        id: item.id, name: typeof item.name === "string" && item.name ? item.name : item.id,
        provider: providerId, api, baseUrl, reasoning: item.reasoning ?? false,
        ...(safeThinkingMap(item.thinkingLevelMap) ? { thinkingLevelMap: safeThinkingMap(item.thinkingLevelMap) } : {}),
        input, contextWindow: item.contextWindow ?? 128000, maxTokens: item.maxTokens ?? 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(Object.keys(importedCompat).length ? { compat: importedCompat } : {}),
      };
      const definition = safeDefinition(model, "custom", importedCompat);
      produced.set(item.id, { model, definition, reason });
    }
    const overrides = object(providerConfig.modelOverrides) ? providerConfig.modelOverrides : {};
    if (own(providerConfig, "modelOverrides") && !object(providerConfig.modelOverrides)) warnings.push(`providers.${providerId}.modelOverrides 已忽略：必须是对象`);
    for (const [modelId, override] of Object.entries(overrides)) {
      const path = `providers.${providerId}.modelOverrides.${modelId}`;
      if (!object(override)) { warnings.push(`${path} 已忽略：override 必须是对象`); continue; }
      const overrideUnknown = warnUnknown(warnings, path, override, overrideAllowed);
      const prior = produced.get(modelId);
      const base = prior?.model ?? baseModels.find((model) => model.id === modelId);
      if (!base) { warnings.push(`${path} 已忽略：锁定 Pi 目录中没有该模型`); continue; }
      let reason = prior?.reason ?? providerUnsafe[0] ?? null;
      const overrideCompat = parseCompat(override.compat);
      const importedCompat = {
        ...(prior?.definition.compat ?? providerCompat.value ?? {}),
        ...(overrideCompat.value ?? {}),
      };
      if (overrideUnknown.length) reason ??= "存在安全导入白名单之外的 override 字段";
      if (own(override, "reasoning") && typeof override.reasoning !== "boolean") reason ??= "reasoning 必须是布尔值";
      if (own(override, "thinkingLevelMap") && !object(override.thinkingLevelMap)) reason ??= "thinkingLevelMap 必须是对象";
      if (own(override, "contextWindow") && typeof override.contextWindow !== "number") reason ??= "contextWindow 必须是数字";
      if (own(override, "maxTokens") && typeof override.maxTokens !== "number") reason ??= "maxTokens 必须是数字";
      if (own(override, "headers")) reason ??= "模型 headers 可能包含秘密且 bridge 不会导入";
      if (own(override, "samplingParams")) reason ??= "samplingParams 会逐字段覆盖 wire 请求，安全导入暂不支持";
      if (overrideCompat.error) reason ??= overrideCompat.error;
      if (Object.keys(importedCompat).length && base.api !== "openai-completions") reason ??= "该 compat 白名单仅适用于 openai-completions";
      if (own(override, "cost")) warnings.push(`${path}.cost 已忽略：目录能力不会自动应用价格`);
      for (const field of ["headers", "samplingParams"]) if (own(override, field)) warnings.push(`${path}.${field} 已忽略：不能安全保留其请求语义`);
      const model = {
        ...applyOverride({ ...base, baseUrl: providerBaseUrl ?? base.baseUrl }, override),
        ...(Object.keys(importedCompat).length ? { compat: { ...base.compat, ...importedCompat } } : {}),
      };
      produced.set(modelId, {
        model, definition: safeDefinition(model, prior?.definition.kind ?? "builtin_override", importedCompat), reason,
      });
    }
    const providerWide = own(providerConfig, "baseUrl") || providerUnsafe.length > 0 || Boolean(providerCompat.value);
    if (providerWide) {
      for (const base of baseModels) {
        if (produced.has(base.id)) continue;
        const model = {
          ...base, baseUrl: providerBaseUrl ?? base.baseUrl,
          ...(providerCompat.value ? { compat: { ...base.compat, ...providerCompat.value } } : {}),
        };
        produced.set(base.id, {
          model, definition: safeDefinition(model, "builtin_override", providerCompat.value),
          reason: providerUnsafe[0] ?? null,
        });
      }
    }
    if (!baseProvider && configuredModels.length === 0) warnings.push(`providers.${providerId}: 没有可导入的 models 定义`);
    for (const { model, definition, reason } of produced.values()) {
      let modes = definition.kind === "custom" ? ["api_key"] : authModes(baseProvider);
      const original = baseModels.find((base) => base.id === model.id);
      if (definition.kind === "builtin_override" && original?.baseUrl !== model.baseUrl) {
        modes = modes.filter((mode) => mode !== "oauth");
      }
      entries.push(catalogEntry(model, baseProvider, definition, reason, modes));
    }
  }
  for (const key of ["prompt", "prompts", "tools", "extensions"]) if (own(config, key)) warnings.push(`root.${key} 已忽略：评测固定提示、禁用工具且不加载扩展`);
  return { type: "result", version: installed.version, models: entries, warnings: [...new Set(warnings)] };
}

async function main() {
  if (installed.version !== pkg.dependencies["@earendil-works/pi-ai"]) reject("profile_incompatible", "Pi 依赖版本与锁定版本不一致");
  if (process.argv.includes("--version")) {
    send({ pi_ai: installed.version, policy: policy.version });
    return;
  }
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 2 * 1024 * 1024) reject("provider_input_too_large", "Pi 输入超过 2 MiB");
  }
  const req = JSON.parse(input);
  if (req.operation === "catalog") { send(catalogResult()); return; }
  if (req.operation === "import-preview") { send(importPreview(req.config)); return; }
  const p = req.parameters;
  let credential = req.credential;
  secretValues = [credential?.key, credential?.access, credential?.refresh].filter(v => typeof v === "string" && v);
  if (!p || !req.model_id || !["check", "generate"].includes(req.operation)) reject("profile_incompatible", "Pi 请求缺少模型或操作");
  const models = isolatedBuiltinModels({
    credentials: {
      read: async (id) => id === p.provider ? credential : undefined,
      list: async () => [{ providerId: p.provider, type: credential.type }],
      modify: async (id, fn) => {
        if (id !== p.provider) reject("provider_auth_error", "OAuth provider 不匹配");
        credential = await fn(credential) ?? credential;
        return credential;
      },
      delete: async () => reject("provider_auth_error", "评测运行不能删除认证信息"),
    },
  });
  let provider = models.getProvider(p.provider);
  let model = models.getModel(p.provider, req.model_id);
  let modelSource = "requested_catalog";
  const imported = p.custom_model;
  if (imported) {
    const importedModel = {
      id: imported.id, name: imported.name, provider: imported.provider, api: imported.api,
      baseUrl: imported.baseUrl, reasoning: imported.reasoning,
      ...(imported.thinkingLevelMap ? { thinkingLevelMap: imported.thinkingLevelMap } : {}),
      ...(imported.compat ? { compat: imported.compat } : {}),
      input: imported.input, contextWindow: imported.contextWindow, maxTokens: imported.maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    if (imported.source.piVersion !== installed.version) reject("profile_incompatible", "导入模型定义的 Pi 版本与锁定运行时不一致");
    if (imported.kind === "builtin_override") {
      if (!provider || !model) reject("profile_incompatible", "导入的内置模型 override 在锁定 Pi 目录中不存在");
      if (p.auth_mode === "oauth" && imported.baseUrl !== model.baseUrl) reject("profile_incompatible", "订阅 OAuth 的内置模型 override 不允许改变服务端地址");
      if (imported.api !== model.api) reject("profile_incompatible", "内置模型 override 不允许改变协议");
      model = {
        ...model, name: imported.name, baseUrl: imported.baseUrl, reasoning: imported.reasoning,
        thinkingLevelMap: imported.thinkingLevelMap, input: imported.input,
        contextWindow: imported.contextWindow, maxTokens: imported.maxTokens,
        ...(imported.compat ? { compat: { ...model.compat, ...imported.compat } } : {}),
      };
    } else {
      const apiModule = importApis.get(imported.api);
      if (!apiModule) reject("profile_incompatible", `导入模型协议不受支持：${imported.api}`);
      model = importedModel;
      provider = createProvider({ id: p.provider, models: [model], api: apiModule,
        auth: { apiKey: { resolve: async () => ({ apiKey: credential.key }) } } });
    }
    modelSource = "pi_models_json_import_preview";
  } else if (!model && req.base_url && p.auth_mode === "api_key") {
    model = {
      id: req.model_id, name: req.model_id, provider: p.provider, api: "openai-completions",
      baseUrl: req.base_url, reasoning: false, input: ["text"],
      contextWindow: 128000, maxTokens: p.max_tokens ?? 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
    };
    provider = createProvider({ id: p.provider, models: [model], api: openaiCompletions,
      auth: { apiKey: { resolve: async () => ({ apiKey: credential.key }) } } });
    modelSource = "requested_custom_endpoint";
  }
  if (!provider || !model) reject("profile_incompatible", "锁定 Pi 目录未包含该 provider/model；API 自定义模型需明确配置兼容端点 Base URL");
  if (!supportedApis.has(model.api)) reject("profile_incompatible", `该 Pi 协议尚不满足单次无工具审计合同：${model.api}`);
  if (p.auth_mode === "oauth" && (!provider.auth.oauth || (req.base_url && imported?.kind !== "builtin_override"))) reject("profile_incompatible", "该 provider 不支持订阅 OAuth，或尝试覆盖订阅端点");
  if (p.auth_mode === "api_key" && credential?.type !== "api_key") reject("provider_auth_error", "缺少 API Key 凭证");
  if (p.auth_mode === "oauth" && credential?.type !== "oauth") reject("provider_auth_error", "缺少 OAuth 凭证");
  if (model.api === "openai-codex-responses" && p.max_tokens !== undefined) reject("profile_incompatible", "Codex 订阅通道不发送 max_tokens");
  if (p.reasoning_effort && (!model.reasoning || !getSupportedThinkingLevels(model).includes(p.reasoning_effort))) reject("profile_incompatible", "该模型不支持请求的 reasoning_effort，禁止静默降档");
  if (req.base_url) model = { ...model, baseUrl: req.base_url };
  const { custom_model: _definition, ...publicParameters } = p;
  evidence = {
    harness: "pi-ai", harness_version: installed.version, policy_version: policy.version,
    bridge_sha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    dependency_lock_sha256: hash(readFileSync(resolve(root, "pnpm-lock.yaml"))),
    system_prompt_sha256: hash(policy.system_prompt), system_prompt: policy.system_prompt,
    tools_enabled: false, tool_count: 0, tool_calls_observed: 0,
    context_isolated: true, context_files_loaded: false, extensions_loaded: false,
    generation_attempt_limit: 1, retry_limit: 0, generation_attempts: 0,
    provider: p.provider, auth_mode: p.auth_mode, api: model.api,
    model_identity_source: modelSource, requested_model_id: req.model_id,
    ...(imported ? { imported_definition_sha256: hash(JSON.stringify(imported)), imported_definition_source: imported.source } : {}),
    effective_parameters: { ...publicParameters, max_tokens: model.api === "openai-codex-responses" ? "provider_managed" : p.max_tokens ?? Math.min(model.maxTokens, 8192) },
    parameter_notes: model.api === "openai-codex-responses" ? ["输出上限由订阅端点控制，未发送 max_tokens"] : [],
    billing_basis: p.auth_mode === "oauth" ? "subscription_or_provider_extra_usage" : "api",
  };
  if (req.operation === "check") { send({ type: "result", evidence }); return; }
  const started = performance.now();
  const controller = new AbortController();
  const context = {
    systemPrompt: policy.system_prompt,
    messages: [{ role: "user", content: `${req.prompt}\n\nOutput JSON schema:\n${JSON.stringify(req.output_schema)}`, timestamp: 0 }],
    tools: [],
  };
  let auth = { apiKey: credential.key };
  if (p.auth_mode === "oauth") {
    if (credential.expires <= Date.now()) reject("provider_auth_error", "Pi 的订阅登录已过期：请先运行 Pi 刷新登录后重试");
    auth = await provider.auth.oauth.toAuth(credential);
    if (auth.baseUrl) model = { ...model, baseUrl: auth.baseUrl };
  }
  const nativeFetch = globalThis.fetch;
  let wirePayload;
  let requestId = null;
  const countedFetch = async (url, init) => {
    if (evidence.generation_attempts !== 0) reject("adapter_policy_violation", "Pi 尝试第二次网络请求，已阻断自动重试");
    if (!wirePayload) reject("adapter_policy_violation", "Pi 未提供可审计的请求载荷");
    evidence.generation_attempts = 1;
    send({ type: "requested", evidence: safe({ ...evidence, wire_payload: wirePayload, wire_payload_sha256: hash(JSON.stringify(wirePayload)) }) });
    const response = await nativeFetch(url, { ...init, redirect: "error" });
    requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");
    return response;
  };
  globalThis.fetch = countedFetch;
  const options = {
    ...auth, signal: controller.signal, maxRetries: 0, transport: "sse", cacheRetention: "none",
    timeoutMs: p.timeout_seconds * 1000, toolChoice: "none", fetch: countedFetch,
    ...(p.temperature === undefined ? {} : { temperature: p.temperature }),
    ...(model.api === "openai-codex-responses" ? {} : { maxTokens: p.max_tokens ?? Math.min(model.maxTokens, 8192) }),
    ...(p.reasoning_effort ? { reasoning: p.reasoning_effort } : {}),
    onPayload: (body) => {
      if ((body.tools?.length ?? 0) || (body.config?.tools?.length ?? 0)) reject("adapter_policy_violation", "SDK 尝试添加工具声明");
      wirePayload = JSON.parse(JSON.stringify(body));
      evidence.effective_parameters.wire_generation = Object.fromEntries(
        ["temperature", "max_tokens", "max_completion_tokens", "max_output_tokens", "reasoning", "thinking", "generationConfig"]
          .filter(key => body[key] !== undefined).map(key => [key, body[key]]),
      );
      if (body.config) evidence.effective_parameters.wire_generation.config = {
        temperature: body.config.temperature, maxOutputTokens: body.config.maxOutputTokens,
        thinkingConfig: body.config.thinkingConfig,
      };
    },
  };
  const stream = provider.streamSimple(model, context, options);
  let textBytes = 0;
  try {
    for await (const event of stream) {
      if (event.type.startsWith("toolcall_")) {
        evidence.tool_calls_observed += 1;
        controller.abort();
        reject("adapter_policy_violation", "模型尝试调用工具；未执行，未继续对话");
      }
      if (event.type === "text_delta") {
        textBytes += Buffer.byteLength(event.delta);
        if (textBytes > 512 * 1024) { controller.abort(); reject("provider_output_too_large", "模型文本超过 512 KiB"); }
        send({ type: "delta", text: safe(event.delta) });
      }
    }
    const result = await stream.result();
    if (result.content.some(block => block.type === "toolCall")) reject("adapter_policy_violation", "模型返回工具调用；未执行");
    if (result.stopReason !== "stop") reject(result.stopReason === "length" ? "provider_output_truncated" : "provider_error", result.errorMessage || `模型未正常完成：${result.stopReason}`);
    if (evidence.generation_attempts !== 1) reject("adapter_policy_violation", "不能证明恰好一次模型请求");
    send({ type: "result", raw_output: safe(result.content.filter(b => b.type === "text").map(b => b.text).join("")),
      token_usage: { input_tokens: result.usage.input, output_tokens: result.usage.output,
        cache_read_tokens: result.usage.cacheRead, cache_write_tokens: result.usage.cacheWrite },
      provider_request_id: requestId, latency_ms: performance.now() - started, evidence: safe(evidence) });
  } finally {
    globalThis.fetch = nativeFetch;
    controller.abort();
  }
}

main().catch(error => {
  send({ type: "error", error: { code: error.code || "provider_runtime_error", message: safe(String(error.message || error)) }, evidence: safe(evidence) });
  process.exitCode = 1;
});
