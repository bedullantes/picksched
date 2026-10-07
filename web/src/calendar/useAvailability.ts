import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { Availability } from '../api/types';
import { useOnline } from '../lib/useOnline';

export interface AvailabilityParams {
  start: string;
  days: number;
  courtId?: string;
  mine: boolean;
}

/** 'live' = receiving push updates; otherwise we fall back to polling. */
export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'unsupported';

const POLL_WHEN_LIVE_MS = 120_000;
const POLL_WHEN_NOT_LIVE_MS = 20_000;
const CHANGE_DEBOUNCE_MS = 250;

/**
 * Loads calendar availability and keeps it current:
 *  - refetches when the server pushes a relevant schedule change (SSE)
 *  - polls as a fallback (faster when the push channel is down)
 *  - refetches when the tab becomes visible or the connection comes back
 */
export function useAvailability(params: AvailabilityParams) {
  const key = `${params.start}|${params.days}|${params.courtId ?? ''}|${params.mine}`;
  const [data, setData] = useState<{ key: string; value: Availability } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [inFlight, setInFlight] = useState(0);
  const [live, setLive] = useState<LiveStatus>('connecting');
  const online = useOnline();

  const latestRequest = useRef(0);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const refetch = useCallback(async () => {
    const id = ++latestRequest.current;
    const p = paramsRef.current;
    const requestKey = `${p.start}|${p.days}|${p.courtId ?? ''}|${p.mine}`;
    setInFlight((n) => n + 1);
    try {
      const value = await api<Availability>('/api/availability', {
        query: { start: p.start, days: p.days, courtId: p.courtId, mine: p.mine ? '1' : undefined },
      });
      if (id === latestRequest.current) {
        setData({ key: requestKey, value });
        setError(null);
      }
    } catch (err) {
      if (id === latestRequest.current) {
        setError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', 'Could not load availability.'));
      }
    } finally {
      setInFlight((n) => n - 1);
    }
  }, []);

  // Load whenever the requested range changes.
  useEffect(() => {
    setError(null);
    void refetch();
  }, [key, refetch]);

  const current = data?.key === key ? data.value : null;
  const currentRef = useRef(current);
  currentRef.current = current;

  // Debounced refetch, so a burst of changes causes one request.
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refetchSoon = useCallback(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void refetch(), CHANGE_DEBOUNCE_MS);
  }, [refetch]);
  useEffect(() => () => clearTimeout(debounce.current), []);

  // Push updates.
  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      setLive('unsupported');
      return;
    }
    const es = new EventSource('/api/events');
    let dropped = false;
    es.addEventListener('ready', () => {
      setLive('live');
      if (dropped) refetchSoon(); // we may have missed changes while disconnected
      dropped = false;
    });
    es.addEventListener('schedule-changed', (e) => {
      const view = currentRef.current;
      if (!view) return refetchSoon();
      try {
        const change = JSON.parse((e as MessageEvent).data) as { courtId: string; startTime: string; endTime: string };
        const inView = view.courts.some((c) => c.id === change.courtId);
        const first = view.slots[0]?.startTime;
        const last = view.slots[view.slots.length - 1]?.endTime;
        const overlaps = !first || !last || (change.startTime < last && change.endTime > first);
        if (inView && overlaps) refetchSoon();
      } catch {
        refetchSoon();
      }
    });
    es.addEventListener('resync', refetchSoon);
    es.onerror = () => {
      dropped = true;
      setLive('reconnecting');
    };
    return () => es.close();
  }, [refetchSoon]);

  // Polling fallback.
  useEffect(() => {
    if (!online) return;
    const ms = live === 'live' ? POLL_WHEN_LIVE_MS : POLL_WHEN_NOT_LIVE_MS;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refetch();
    }, ms);
    return () => clearInterval(timer);
  }, [live, online, refetch]);

  // Catch up after the tab was hidden or the connection was lost.
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) void refetch();
    wasOnline.current = online;
  }, [online, refetch]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refetch();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refetch]);

  return {
    data: current,
    error,
    loading: !current && !error,
    refreshing: inFlight > 0 && !!current,
    live,
    online,
    refetch,
  };
}
