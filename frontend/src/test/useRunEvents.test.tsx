import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { useRunEvents } from "../hooks/useRunEvents";
import type { RunEvent } from "../types";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, EventListener>();
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, listener);
  }

  close() {
    this.closed = true;
  }

  emit(item: RunEvent) {
    this.listeners.get(item.event_type)?.({ data: JSON.stringify(item) } as unknown as Event);
  }
}

const runEvent = (seq: number, eventType = "provider.delta"): RunEvent => ({
  seq,
  event_type: eventType,
  level: "info",
  created_at: "2026-09-19T00:00:00Z",
  model_run_id: 1,
  case_run_id: 1,
  message: "event",
  payload: {},
});

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useRunEvents", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads every history page before streaming from the actual tail", async () => {
    const firstPage = Array.from({ length: 5000 }, (_, index) => runEvent(index + 1));
    vi.spyOn(api, "history").mockImplementation(async (_runId, query = {}) => {
      if (!query.afterSeq) return { events: firstPage, total: 5001 };
      return { events: [runEvent(5001)], total: 1 };
    });

    const { result } = renderHook(() => useRunEvents(41), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.events).toHaveLength(5001));
    expect(result.current.total).toBe(5001);
    act(() => {
      FakeEventSource.instances[0].emit(runEvent(5001));
      FakeEventSource.instances[0].emit(runEvent(5002));
    });
    expect(result.current.events.slice(-2).map((item) => item.seq)).toEqual([5001, 5002]);
    expect(result.current.total).toBe(5002);
  });

  it("surfaces history failure and retry reconnects successfully", async () => {
    vi.spyOn(api, "history")
      .mockRejectedValueOnce(new Error("history unavailable"))
      .mockResolvedValueOnce({ events: [runEvent(1)], total: 1 });
    const { result } = renderHook(() => useRunEvents(42), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.connection).toBe("error"));
    expect(result.current.error).toBe("history unavailable");
    expect(FakeEventSource.instances).toHaveLength(0);

    act(() => result.current.retry());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(result.current.error).toBeNull();
    expect(result.current.events.map((item) => item.seq)).toEqual([1]);

  });

  it("ignores an outdated history completion after switching runs", async () => {
    const oldHistory = deferred<{ events: RunEvent[]; total: number }>();
    vi.spyOn(api, "history").mockImplementation((runId) => {
      if (runId === 1) return oldHistory.promise;
      return Promise.resolve({ events: [runEvent(200)], total: 1 });
    });
    const { result, rerender } = renderHook(({ runId }) => useRunEvents(runId), {
      initialProps: { runId: 1 },
      wrapper: createWrapper(),
    });


    rerender({ runId: 2 });
    await waitFor(() => expect(result.current.events.map((item) => item.seq)).toEqual([200]));

    await act(async () => {
      oldHistory.resolve({ events: [runEvent(100)], total: 1 });
      await oldHistory.promise;
    });
    expect(result.current.events.map((item) => item.seq)).toEqual([200]);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toContain("/runs/2/");
  });

  it("retains the final event and exposes an ended connection", async () => {
    vi.spyOn(api, "history").mockResolvedValue({ events: [], total: 0 });
    const { result } = renderHook(() => useRunEvents(43), { wrapper: createWrapper() });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      FakeEventSource.instances[0].onopen?.();
      FakeEventSource.instances[0].emit(runEvent(1, "run.completed"));
    });

    expect(result.current.events.map((item) => item.event_type)).toEqual(["run.completed"]);
    expect(result.current.total).toBe(1);
    expect(result.current.connection).toBe("ended");
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });
});
