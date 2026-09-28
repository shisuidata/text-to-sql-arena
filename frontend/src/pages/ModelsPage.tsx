import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Check, KeyRound, Plus, RefreshCw, Search, Terminal, Trash2 } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../api/client";
import { EmptyState, PageHeader, StatusPill } from "../components/AppShell";
import { ModelLogo } from "../components/ModelIdentity";
import { displayModelName } from "../lib/modelIdentity";
import type { ModelProfile, PiAuthMode, PiCatalogModel } from "../types";

const parameterText = (profile: ModelProfile, key: string) => {
  const value = profile.parameters[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
};

const modelKey = (model: PiCatalogModel) => `${model.provider}\u0000${model.model_id}`;
const compactNumberFormatter = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });

export function ModelsPage() {
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const catalog = useQuery({ queryKey: ["pi-catalog"], queryFn: api.piCatalog });
  const credentials = useQuery({ queryKey: ["pi-credentials"], queryFn: api.piCredentials });
  const [showForm, setShowForm] = useState(false);
  const [provider, setProvider] = useState("");
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [authMode, setAuthMode] = useState<PiAuthMode>("api_key");
  const [temperature, setTemperature] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const sourceModels = useMemo(() => catalog.data?.models ?? [], [catalog.data?.models]);
  const providers = useMemo(() => [...new Set(sourceModels.map((model) => model.provider))].sort((a, b) => a.localeCompare(b)), [sourceModels]);
  const visibleModels = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return sourceModels.filter((model) => (!provider || model.provider === provider) && (!query || `${model.name} ${model.model_id}`.toLocaleLowerCase().includes(query)));
  }, [provider, search, sourceModels]);
  const selectedModel = sourceModels.find((model) => modelKey(model) === selectedKey) ?? null;
  const isCodexApi = selectedModel?.api === "openai-codex-responses";
  const isOAuth = authMode === "oauth";
  const credentialTypes = credentials.data?.providers.find((entry) => entry.provider === selectedModel?.provider)?.types ?? [];
  const hasApiKey = credentialTypes.includes("api_key");
  const hasOauth = credentialTypes.includes("oauth");
  const isLoopback = (() => {
    const url = selectedModel?.base_url;
    if (!url) return false;
    try {
      const hostname = new URL(url).hostname;
      return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    } catch {
      return false;
    }
  })();
  const credentialNote = !selectedModel ? "" : isOAuth
    ? hasOauth ? `凭据：Pi 订阅登录（${selectedModel.provider}）· 运行时读取，评测台不刷新` : ""
    : hasApiKey ? `凭据：Pi 本机 auth.json（已保存 ${selectedModel.provider}）· 运行时读取，不复制、不回显`
    : isLoopback ? "凭据：本机环回端点不发送凭据" : "";
  const credentialMissing = Boolean(selectedModel && !credentialNote);

  const clearParameters = () => {
    setTemperature("");
    setMaxTokens("");
    setReasoningEffort("");
  };
  const clearSelection = () => {
    setSelectedKey("");
    setDisplayName("");
    setAuthMode("api_key");
    clearParameters();
  };
  const chooseModel = (model: PiCatalogModel) => {
    if (!model.supported) return;
    setSelectedKey(modelKey(model));
    setDisplayName(model.name || model.model_id);
    setAuthMode(model.auth_modes[0] ?? "api_key");
    clearParameters();
  };

  const create = useMutation({
    mutationFn: api.createProfile,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profiles"] });
      setShowForm(false);
      toast.success("模型配置已添加");
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const check = useMutation({ mutationFn: api.checkProfile, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["profiles"] }), onError: (error: Error) => toast.error(error.message) });
  const remove = useMutation({ mutationFn: api.deleteProfile, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["profiles"] }) });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!selectedModel) { toast.error("请先选择一个可用模型"); return; }

    const actualAuth: PiAuthMode = authMode;
    const actualProvider = selectedModel.provider;

    const optionalNumber = (value: string) => value.trim() ? Number(value) : undefined;
    const rate = (name: string) => { const value = String(data.get(name) ?? "").trim(); return value ? Number(value) : null; };
    const rates = {
      input_usd_per_million: rate("input_price"),
      cached_input_usd_per_million: rate("cached_input_price"),
      cache_write_input_usd_per_million: rate("cache_write_price"),
      output_usd_per_million: rate("output_price"),
    };
    const parameters: Record<string, unknown> = { provider: actualProvider, auth_mode: actualAuth, timeout_seconds: 180 };
    const temperatureValue = optionalNumber(temperature);
    const maxTokensValue = optionalNumber(maxTokens);
    if (temperatureValue !== undefined) parameters.temperature = temperatureValue;
    if (!isCodexApi && maxTokensValue !== undefined) parameters.max_tokens = maxTokensValue;
    if (selectedModel.reasoning_levels.length && reasoningEffort) parameters.reasoning_effort = reasoningEffort;
    if (selectedModel.definition) parameters.custom_model = selectedModel.definition;

    create.mutate({
      name: displayName.trim(),
      adapter_kind: "pi",
      model_id: selectedModel.model_id,
      base_url: actualAuth === "oauth" && !selectedModel.definition ? null : selectedModel.base_url || null,
      response_mode: "text",
      parameters,
      pricing: actualAuth === "api_key" && Object.values(rates).some((value) => value !== null) ? {
        currency: "USD",
        ...rates,
        source: data.get("price_source") || "manual",
        effective_at: data.get("price_date") || new Date().toISOString().slice(0, 10),
      } : null,
    });
  };

  const catalogState = catalog.isPending ? <div className="catalog-state"><RefreshCw className="spin"/>正在读取已接入模型…</div> : catalog.isError ? <div className="catalog-state error"><span>模型配置读取失败：{catalog.error.message}</span><button type="button" className="button" onClick={() => catalog.refetch()}>重试</button></div> : !catalog.data?.models.length ? <div className="catalog-state">尚未发现已接入模型。请先在本机 Pi 的 enabledModels 中启用模型，然后重新读取。</div> : null;
  const sourceVersion = catalog.data?.version;

  return <div className="page models-page">
    <PageHeader eyebrow="模型配置" title="模型与统一调用配置" description="仅展示当前已接入模型，不展示完整内置目录。" actions={<button className="button primary" onClick={() => setShowForm(!showForm)}><Plus/>添加模型</button>}/>
    {showForm && <form className="profile-form model-setup" onSubmit={submit}>
      {catalogState}
      {Boolean(catalog.data?.models.length) && <p className="form-note">按本机 enabledModels 展示 {catalog.data?.models.length} 个模型；只读取模型名单与声明式定义，不加载扩展、提示词或会话。</p>}
      {Boolean(catalog.data?.models.length) && <>
        <div className="catalog-toolbar">
          <label>Provider<select value={provider} onChange={(event) => { setProvider(event.target.value); clearSelection(); }}><option value="">全部 Provider</option>{providers.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label>搜索模型<span className="search-field"><Search/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="名称或 Model ID"/></span></label>
          {sourceVersion && <p>目录版本 <code>{sourceVersion}</code></p>}
        </div>
        {!visibleModels.length ? <div className="catalog-state">没有符合当前 Provider 与搜索条件的模型。</div> : <div className="catalog-models" aria-label="模型候选">
          {visibleModels.map((model) => <button type="button" key={modelKey(model)} disabled={!model.supported} className={`catalog-model ${selectedKey === modelKey(model) ? "selected" : ""}`} onClick={() => chooseModel(model)}>
            <span><b>{model.name}</b><code>{model.model_id}</code></span>
            <span className="catalog-model-meta"><span>{model.provider}{model.api ? ` · ${model.api}` : " · 定义待解析"}</span>{model.api && <><span>{compactNumberFormatter.format(model.context_window)} 上下文</span><span>{compactNumberFormatter.format(model.max_tokens)} 输出</span></>}</span>
            {!model.supported ? <span className="unsupported-reason">不可用：{model.unavailable_reason || "当前评测运行时不支持"}</span> : selectedKey === modelKey(model) ? <Check aria-hidden="true"/> : null}
          </button>)}
        </div>}
      </>}

      {selectedModel && <section className="model-config-fields" key={`${selectedKey}:${authMode}`}>
        <div className="capability-strip">
          <div><span>协议</span><b>{selectedModel.api}</b></div>
          <div><span>上下文窗口</span><b>{selectedModel.context_window.toLocaleString("zh-CN")}</b></div>
          <div><span>目录输出上限</span><b>{selectedModel.max_tokens.toLocaleString("zh-CN")}</b></div>
          <div><span>目录版本</span><b>{sourceVersion}</b></div>
        </div>
        <p className="catalog-disclaimer">目录展示的是参考能力与本评测台兼容性，不代表你的账号拥有模型权限，也不会自动应用目录价格。保存后请执行本地配置检查。</p>
        <div className="form-grid">
          <label>显示名称<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required placeholder="用于评测台展示"/></label>
          <label>认证方式<select value={authMode} onChange={(event) => setAuthMode(event.target.value as PiAuthMode)}>{selectedModel.auth_modes.map((mode) => <option key={mode} value={mode}>{mode === "oauth" ? "OAuth" : "API Key"}</option>)}</select></label>
          <label>凭据说明<input readOnly value={credentialNote || `Pi 本机 auth.json 没有 ${selectedModel.provider} 的凭据：请先在 Pi 中登录或配置`}/></label>
          <label>Temperature（可选）<input value={temperature} onChange={(event) => setTemperature(event.target.value)} type="number" step="any"/></label>
          {isCodexApi ? <label>Max tokens<input value="provider_managed" readOnly/></label> : <label>Max tokens（可选）<input value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} type="number" min="1" step="1"/></label>}
          {selectedModel.reasoning_levels.length ? <label>Reasoning effort（可选）<select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}><option value="">使用 Provider 默认值</option>{selectedModel.reasoning_levels.map((level) => <option key={level} value={level}>{level}</option>)}</select></label> : null}
          <label>调用超时<input value="180 秒（固定）" readOnly/></label>
          {!isOAuth && <><label>输入价 USD / 百万 Token<input name="input_price" type="number" min="0" step="any" placeholder="手工填写；不填则不估算"/></label>
          <label>缓存输入价 USD / 百万 Token<input name="cached_input_price" type="number" min="0" step="any" placeholder="可选"/></label>
          <label>缓存写入价 USD / 百万 Token<input name="cache_write_price" type="number" min="0" step="any" placeholder="可选"/></label>
          <label>输出价 USD / 百万 Token<input name="output_price" type="number" min="0" step="any" placeholder="手工填写；不填则不估算"/></label>
          <label>价格来源<input name="price_source" placeholder="manual / 官方价格页"/></label>
          <label>价格生效日期<input name="price_date" type="date"/></label></>}
        </div>
        {isOAuth && <p className="form-note">OAuth 使用 Pi 本机订阅登录；评测台不复制、不刷新凭据。“检查本地配置”不会调用付费模型，也不证明账号具备模型权限。</p>}
      </section>}
      <div className="form-actions"><button className="button primary" disabled={create.isPending || !selectedModel || credentialMissing}>保存配置</button><button className="button ghost" type="button" onClick={() => setShowForm(false)}>取消</button></div>
    </form>}

    {profiles.isPending ? <div className="catalog-state">正在读取已保存配置…</div> : profiles.isError ? <div className="catalog-state error">模型配置读取失败：{profiles.error.message}</div> : !profiles.data?.length ? <EmptyState icon={<Terminal/>} title="没有模型配置" body="添加模型配置；真实运行前先检查本地目录、凭据与参数是否就绪。"/> : <div className="profile-list">{[...profiles.data].sort((a, b) => Number(b.adapter_kind === "pi") - Number(a.adapter_kind === "pi")).map((profile) => {
      const current = profile.adapter_kind === "pi";
      const savedProvider = parameterText(profile, "provider");
      const savedAuthMode = parameterText(profile, "auth_mode");
      return <article className={`profile-row ${current ? "" : "historical-profile"}`} key={profile.id}>
        <div className="profile-icon"><ModelLogo name={profile.name} modelId={profile.model_id} adapterKind={profile.adapter_kind}/></div>
        <div className="profile-main"><div><h3>{displayModelName(profile.name)}</h3><StatusPill status={profile.health_status}/>{!current && <span className="historical-badge">历史配置 · 仅查看</span>}</div><code>{profile.model_id}</code><p>{current ? "受控调用 · " : ""}{profile.response_mode}{savedProvider ? ` · ${savedProvider}` : ""}{savedAuthMode ? ` · ${savedAuthMode}` : ""}</p></div>
        <div className="health-detail"><small>{current ? "PI / LOCAL READINESS" : "HISTORICAL ADAPTER"}</small><b>{String(profile.health_details.version ?? profile.health_details.command ?? (current ? "待检查" : profile.adapter_kind))}</b><span><KeyRound/> {profile.secret_backend === "pi" ? `Pi 本机凭据 · ${savedProvider}（未复制）` : profile.has_secret ? "历史凭据引用 · 不再解析" : savedAuthMode === "oauth" ? (profile.health_status === "healthy" ? "Pi 订阅登录已就绪" : "需在 Pi 中完成登录") : "未配置密钥"}</span>{current && profile.health_status === "unavailable" && savedAuthMode === "oauth" && <span>请先运行 Pi 登录（GPT 也可使用既有 Codex 登录），再检查本地配置。</span>}</div>
        <div className="profile-actions">{current && <button type="button" className="button" disabled={check.isPending} onClick={() => check.mutate(profile.id)}><Activity/>检查本地配置</button>}<button type="button" className="icon-button danger" aria-label={`删除 ${profile.name}`} onClick={() => remove.mutate(profile.id)}><Trash2/></button></div>
      </article>;
    })}</div>}
  </div>;
}
