import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { bootstrap } from "./api/client";
import "./tokens.css";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } } });

async function start() {
  await bootstrap();
  createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={queryClient}><BrowserRouter><App/></BrowserRouter></QueryClientProvider></StrictMode>);
}

start().catch((error: Error) => { document.getElementById("root")!.innerHTML = `<main class="boot-error"><b>评测工具启动失败</b><p>${error.message}</p></main>`; });
