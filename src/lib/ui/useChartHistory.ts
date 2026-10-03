'use client';
import { useEffect, useRef, useState } from 'react';
import { computeAllIndicators } from '@/lib/indicators';
import { MAX_CHART_CANDLES, mergeChartCandles } from './chartHistory';

export function useChartHistory(fetcher: (url: string, init?: RequestInit) => Promise<Response>, asset: string, interval: string, portfolio: string) {
  const [chartData, setChartData] = useState<any>(null);
  const [chartLoading, setChartLoading] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const requestRef = useRef<(older: boolean) => Promise<void>>(async () => {});

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false, busy = false;
    let current: any = null, windowVersion = 0;
    setChartData(null); setChartLoading(true); setChartError(null); setHistoryLoading(false);
    const load = async (older: boolean, reset = false) => {
      if (busy || cancelled || (older && (!current?.hasMore || !current.nextBeforeMs))) return;
      busy = true;
      if (older) setHistoryLoading(true);
      try {
        const cursor = older ? `&before=${current.nextBeforeMs}` : '';
        const res = await fetcher(`/api/chart?interval=${interval}&limit=1000&asset=${asset}&portfolio=${portfolio}${cursor}`, { signal: controller.signal });
        const payload = await res.json();
        if (cancelled) return;
        if (!res.ok || payload.asset !== asset || payload.interval !== interval || !Array.isArray(payload.candles)) {
          throw new Error(payload.error || 'Chart page unavailable');
        }
        const candles = mergeChartCandles(reset ? [] : current?.candles ?? [], payload.candles, older ? 'older' : 'latest');
        if (reset) windowVersion++;
        current = { ...payload, candles, windowVersion, indicators: computeAllIndicators(candles),
          hasMore: older || !current || reset ? payload.hasMore : current.hasMore,
          nextBeforeMs: candles.length ? candles[0].time * 1000 : null,
          historyWindow: !reset && (current?.historyWindow || (older && (current?.candles.length ?? 0) + payload.candles.length > MAX_CHART_CANDLES)),
          // A historical page's end is not the current live bar.
          asOf: older ? current?.asOf : payload.asOf, stale: older ? current?.stale : payload.stale };
        setChartData(current); setChartError(null);
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) setChartError(error instanceof Error ? error.message : 'Chart page unavailable');
      } finally {
        busy = false;
        if (!cancelled) { setChartLoading(false); setHistoryLoading(false); }
      }
    };
    requestRef.current = older => load(older, !older);
    void load(false, true);
    const timer = setInterval(() => { if (!current?.historyWindow) void load(false); }, 30_000);
    return () => { cancelled = true; controller.abort(); clearInterval(timer); };
  }, [fetcher, asset, interval, portfolio]);
  return { chartData, chartLoading, chartError, historyLoading,
    loadOlder: () => requestRef.current(true), loadLatest: () => requestRef.current(false) };
}
