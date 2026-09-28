import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { ModelsPage } from "../pages/ModelsPage";
import type { ModelProfile, PiCatalogModel } from "../types";

const codexModel: PiCatalogModel = {
  provider: "openai-codex",
  model_id: "gpt-5.6-sol",
  name: "GPT 5.6 Sol",
  api: "openai-codex-responses",
  base_url: "https://chatgpt.com/backend-api/codex",
  context_window: 200_000,
  max_tokens: 64_000,
  reasoning_levels: ["low", "medium", "high"],
  auth_modes: ["oauth"],
  supported: true,
  unavailable_reason: null,
};

const savedProfile: ModelProfile = {
  id: 1,
  name: "GPT 5.6 Sol",
  adapter_kind: "pi",
  model_id: "gpt-5.6-sol",
  base_url: null,
  response_mode: "text",
  parameters: { provider: "openai-codex", auth_mode: "oauth", timeout_seconds: 180 },
  pricing: null,
  enabled: true,
  has_secret: false,
  secret_backend: "none",
  health_status: "unknown",
  health_details: {},
  last_checked_at: null,
  health_expires_at: null,
};

function Wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const deepseekModel = (name: string): PiCatalogModel => ({
  provider: "deepseek-official",
  model_id: name.toLowerCase(),
  name,
  api: "openai-completions",
  base_url: "https://api.deepseek.com/v1",
  context_window: 1_000_000,
  max_tokens: 128_000,
  reasoning_levels: [],
  auth_modes: ["api_key"],
  supported: true,
  unavailable_reason: null,
});

describe("Pi 模型配置", () => {
  it("从目录提交精确模型能力，Codex 不发送 max_tokens", async () => {
    vi.spyOn(api, "profiles").mockResolvedValue([]);
    vi.spyOn(api, "piCredentials").mockResolvedValue({ providers: [{ provider: "openai-codex", types: ["oauth"] }] });
    vi.spyOn(api, "piCatalog").mockResolvedValue({
      version: "pi-2026.09",
      models: [codexModel, { ...codexModel, model_id: "future", name: "Future", supported: false, unavailable_reason: "运行时尚未适配" }],
    });
    const create = vi.spyOn(api, "createProfile").mockResolvedValue(savedProfile);

    render(<ModelsPage/>, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    fireEvent.click(await screen.findByRole("button", { name: /GPT 5.6 Sol/ }));
    expect((screen.getByDisplayValue("provider_managed") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByRole("button", { name: /Future/ })).toBeDisabled();
    expect(screen.getByText("不可用：运行时尚未适配")).toBeVisible();
    expect((screen.getByLabelText("凭据说明") as HTMLInputElement).value).toBe("凭据：Pi 订阅登录（openai-codex）· 运行时读取，评测台不刷新");
    fireEvent.change(screen.getByLabelText("Reasoning effort（可选）"), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0][0];
    expect(payload.base_url).toBeNull();
    expect(payload.pricing).toBeNull();
    expect(payload.parameters).not.toHaveProperty("max_tokens");
    expect(payload).not.toHaveProperty("credential_source");
    expect(payload).not.toHaveProperty("api_key");
    expect(payload).not.toHaveProperty("api_key_env");
    expect(screen.queryByLabelText("输入价 USD / 百万 Token")).not.toBeInTheDocument();
  });

  it("切换模型不把参数与价格带入另一个端点", async () => {
    const first: PiCatalogModel = { ...deepseekModel("First"), provider: "local", reasoning_levels: ["low", "medium", "high"] };
    const second: PiCatalogModel = { ...first, model_id: "second", name: "Second", reasoning_levels: [] };
    vi.spyOn(api, "profiles").mockResolvedValue([]);
    vi.spyOn(api, "piCredentials").mockResolvedValue({ providers: [] });
    vi.spyOn(api, "piCatalog").mockResolvedValue({ version: "0.85.1", models: [first, second] });
    render(<ModelsPage/>, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    fireEvent.click(await screen.findByRole("button", { name: /First/ }));
    fireEvent.change(screen.getByLabelText("Temperature（可选）"), { target: { value: "0.2" } });
    fireEvent.change(screen.getByLabelText("输入价 USD / 百万 Token"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Reasoning effort（可选）"), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: /Second/ }));
    expect(screen.getByLabelText("Temperature（可选）")).toHaveValue(null);
    expect(screen.getByLabelText("输入价 USD / 百万 Token")).toHaveValue(null);
    expect(screen.queryByLabelText("Reasoning effort（可选）")).not.toBeInTheDocument();
    expect((screen.getByLabelText("凭据说明") as HTMLInputElement).value).toBe("Pi 本机 auth.json 没有 local 的凭据：请先在 Pi 中登录或配置");
  });

  it("Pi 已保存 API Key 的模型默认直接复用本机凭据", async () => {
    const localModel = deepseekModel("DeepSeek V4 Flash");
    vi.spyOn(api, "profiles").mockResolvedValue([]);
    vi.spyOn(api, "piCatalog").mockResolvedValue({ version: "0.85.1", models: [localModel] });
    vi.spyOn(api, "piCredentials").mockResolvedValue({
      providers: [{ provider: "deepseek-official", types: ["api_key"] }],
    });
    const create = vi.spyOn(api, "createProfile").mockResolvedValue(savedProfile);

    render(<ModelsPage/>, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    fireEvent.click(await screen.findByRole("button", { name: /DeepSeek V4 Flash/ }));
    await waitFor(() => expect((screen.getByLabelText("凭据说明") as HTMLInputElement).value).toBe("凭据：Pi 本机 auth.json（已保存 deepseek-official）· 运行时读取，不复制、不回显"));
    expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0][0];
    expect(payload).not.toHaveProperty("credential_source");
    expect(payload).not.toHaveProperty("api_key");
    expect(payload).not.toHaveProperty("api_key_env");
    expect(payload.base_url).toBe("https://api.deepseek.com/v1");
  });

  it("Pi 未保存该 Provider 凭据时无法保存", async () => {
    const localModel = deepseekModel("DeepSeek V4 Pro");
    vi.spyOn(api, "profiles").mockResolvedValue([]);
    vi.spyOn(api, "piCatalog").mockResolvedValue({ version: "0.85.1", models: [localModel] });
    vi.spyOn(api, "piCredentials").mockResolvedValue({ providers: [] });
    const create = vi.spyOn(api, "createProfile").mockResolvedValue(savedProfile);

    render(<ModelsPage/>, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    fireEvent.click(await screen.findByRole("button", { name: /DeepSeek V4 Pro/ }));
    await waitFor(() => expect((screen.getByLabelText("凭据说明") as HTMLInputElement).value).toBe("Pi 本机 auth.json 没有 deepseek-official 的凭据：请先在 Pi 中登录或配置"));
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(create).not.toHaveBeenCalled();
  });

  it("本机环回端点不发送凭据且可以保存", async () => {
    const ollamaModel: PiCatalogModel = {
      ...deepseekModel("Local Llama"),
      provider: "ollama",
      base_url: "http://127.0.0.1:11434/v1",
    };
    vi.spyOn(api, "profiles").mockResolvedValue([]);
    vi.spyOn(api, "piCatalog").mockResolvedValue({ version: "0.85.1", models: [ollamaModel] });
    vi.spyOn(api, "piCredentials").mockResolvedValue({ providers: [] });
    const create = vi.spyOn(api, "createProfile").mockResolvedValue(savedProfile);

    render(<ModelsPage/>, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    fireEvent.click(await screen.findByRole("button", { name: /Local Llama/ }));
    await waitFor(() => expect((screen.getByLabelText("凭据说明") as HTMLInputElement).value).toBe("凭据：本机环回端点不发送凭据"));
    expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0][0];
    expect(payload.base_url).toBe("http://127.0.0.1:11434/v1");
    expect(payload).not.toHaveProperty("api_key");
  });
});
