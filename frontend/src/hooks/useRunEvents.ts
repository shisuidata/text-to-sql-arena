import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, eventStream, TERMINAL_EVENT_TYPES } from "../api/client";
import type { RunEvent } from "../types";

const HISTORY_PAGE_SIZE = 5000;

export type RunConnection = "loading" | "connecting" | "live" | "reconnecting" | "ended" | "error";

export interface UseRunEventsResult {
  events: RunEvent[];
  total: number;
  connection: RunConnection;
  error: string | null;
  retry: () => void;
}

export function useRunEvents(runId: number): UseRunEventsResult {
  const queryClient = useQueryClient();
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;
  const [cache, setCache] = useState<{ runId: number; events: RunEvent[] }>({ runId, events: [] });
  const [total, setTotal] = useState(0);
  const [connection, setConnection] = useState<RunConnection>("loading");
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const retry = useCallback(() => setRetryToken((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    let closeStream: () => void = () => undefined;
    setCache({ runId, events: [] });
    setTotal(0);
    setConnection("loading");
    setError(null);

    const start = async () => {
      try {
        const collected: RunEvent[] = [];
        const seen = new Set<number>();
        let afterSeq = 0;
        let initialTotal: number | null = null;

        do {
          const page = await api.history(runId, { afterSeq, limit: HISTORY_PAGE_SIZE });
          if (!active) return;
          if (initialTotal === null) initialTotal = page.total;

          let progressed = false;
          for (const event of page.events) {
            if (event.seq <= afterSeq || seen.has(event.seq)) continue;
            seen.add(event.seq);
            collected.push(event);
            afterSeq = event.seq;
            progressed = true;
          }

          if (collected.length < initialTotal && !progressed) {
            throw new Error("事件历史未完整返回，请重试");
          }
        } while (collected.length < (initialTotal ?? 0));

        collected.sort((left, right) => left.seq - right.seq);
        if (!active) return;
        setCache({ runId, events: collected });
        setTotal(Math.max(initialTotal ?? 0, collected.length));

        if (collected.some((event) => TERMINAL_EVENT_TYPES[event.event_type])) {
          setConnection("ended");
          return;
        }

        setConnection("connecting");
        closeStream = eventStream(
          runId,
          collected.at(-1)?.seq ?? 0,
          (event) => {
            if (!active || seen.has(event.seq)) return;
            seen.add(event.seq);
            setCache((current) => current.runId === runId ? { runId, events: [...current.events, event] } : current);
            setTotal((value) => value + 1);
            if (event.event_type.startsWith("run.")) {
              queryClientRef.current.invalidateQueries({ queryKey: ["run", runId] });
            }
            if (TERMINAL_EVENT_TYPES[event.event_type]) setConnection("ended");
          },
          (connected) => {
            if (!active) return;
            setConnection(connected ? "live" : "reconnecting");
          },
        );
      } catch (cause) {
        if (!active) return;
        setConnection("error");
        setError(cause instanceof Error ? cause.message : "加载运行事件失败");
      }
    };

    void start();
    return () => {
      active = false;
      closeStream();
    };
  }, [retryToken, runId]);

  return cache.runId === runId
    ? { events: cache.events, total, connection, error, retry }
    : { events: [], total: 0, connection: "loading", error: null, retry };
}
