"use client";
import React, { useEffect, useRef } from "react";
import { createChart, ColorType, IChartApi, Time } from "lightweight-charts";
import { Candle } from "@/lib/types";

interface Props {
  candles: Candle[];
  trades: { time: number; action: string; price: number }[];
  indicators: any;
  assetName?: string;
  activePosition?: {
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    direction?: 'LONG' | 'SHORT';
  } | null;
  timezone?: 'EU' | 'UK' | 'IST' | 'US';
  theme?: 'light' | 'dark';
}

/**
 * Returns the UTC offset in SECONDS for the given IANA timezone at the current moment.
 *
 * Strategy: Ask Intl.DateTimeFormat to render the current moment in the target
 * timezone, parse out year/month/day/hour/minute/second, build a UTC epoch from
 * those parts, then diff against Date.now().  That diff IS the UTC offset.
 *
 * Example (UTC+5:30 / Asia/Kolkata):
 *   Now (UTC) = 10:00:00  → Kolkata wall-clock = 15:30:00
 *   targetTime = Date.UTC(…, 15, 30, 0) = now + 5.5 h
 *   offsetSeconds = +19800 (5.5 × 3600)
 */
function getUtcOffsetSeconds(ianaTimezone: string): number {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: ianaTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const get = (type: string): number => {
    const part = parts.find(p => p.type === type);
    return part ? parseInt(part.value, 10) : 0;
  };

  // Wall-clock time in the target timezone
  let h = get('hour');
  // Intl sometimes returns 24 for midnight
  if (h === 24) h = 0;

  // Reconstruct "what UTC epoch corresponds to these wall-clock digits treated as UTC"
  const targetMs = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    h,
    get('minute'),
    get('second'),
  );

  // The difference is the timezone's offset from UTC
  return Math.round((targetMs - now.getTime()) / 1000);
}

export function TradingChart({ candles, trades, indicators, activePosition, assetName, timezone = 'EU', theme = 'dark' }: Props) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const isDark = theme === 'dark';
    const textColor = isDark ? "#A3A3A3" : "#586069";
    const gridColor = isDark ? "#1a1a1a" : "#e2e8f0";

    // Map timezone selector to IANA timezone strings
    // EU  = Europe/Paris   (CET/CEST, UTC+1/+2 — continental European financial time)
    // UK  = Europe/London  (GMT/BST,  UTC+0/+1 — London session / Forex hub)
    // IST = Asia/Kolkata   (IST,      UTC+5:30  — Indian Standard Time)
    // US  = America/New_York (ET,     UTC−5/−4  — Wall Street / NYSE)
    const ianaTimezone =
      timezone === 'IST' ? 'Asia/Kolkata'
      : timezone === 'US'  ? 'America/New_York'
      : timezone === 'UK'  ? 'Europe/London'
      : 'Europe/Paris'; // EU default

    /**
     * WHY WE SHIFT TIMESTAMPS:
     * lightweight-charts v4 treats every timestamp as UTC and renders X-axis
     * tick labels directly from UTC values. There is no built-in timezone support
     * for axis ticks (localization.timeFormatter only affects the crosshair tooltip,
     * NOT the axis labels).
     *
     * The only reliable way to make the axis show e.g. "19:30" for IST when the
     * raw candle is at 14:00 UTC is to ADD the target timezone's UTC offset to
     * every timestamp before feeding it to the chart.  The library then thinks the
     * shifted value IS UTC and renders the correct wall-clock digits.
     */
    const offsetSeconds = getUtcOffsetSeconds(ianaTimezone);

    // Shift a raw UTC unix-second timestamp into the target timezone's "fake UTC"
    const shiftTime = (utcSec: number): Time => (utcSec + offsetSeconds) as Time;

    const chart = createChart(chartContainerRef.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor },
      grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
      width: chartContainerRef.current.clientWidth,
      height: 400,
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    chartRef.current = chart;

    // After creating the chart, add an info overlay div
    const legend = document.createElement('div');
    legend.style.position = 'absolute';
    legend.style.top = '8px';
    legend.style.left = '8px';
    legend.style.zIndex = '10';
    legend.style.fontSize = '10px';
    legend.style.fontFamily = 'JetBrains Mono, monospace';
    legend.style.color = isDark ? '#a3a3a3' : '#24292e';
    legend.style.backgroundColor = isDark ? 'rgba(15,15,15,0.8)' : 'rgba(255,255,255,0.85)';
    legend.style.padding = '6px 10px';
    legend.style.borderRadius = '6px';
    legend.style.border = isDark ? '1px solid #262626' : '1px solid #e1e4e8';
    legend.style.lineHeight = '1.6';

    const tzLabel =
      timezone === 'IST' ? 'IST (UTC+5:30)'
      : timezone === 'US'  ? 'US/NY (UTC−4/5)'
      : timezone === 'UK'  ? 'UK/London (UTC+0/1)'
      : 'Paris (UTC+1/2)'; // EU
    legend.innerHTML = `
      ${assetName ? `<strong style="color:${isDark ? '#e5e5e5' : '#1f2937'};font-size:12px">${assetName}</strong><br>` : ''}
      <span style="color:#f97316">━</span> EMA9 (Fast Trend)
      <span style="color:#3b82f6">━</span> EMA50 (Slow Trend)
      <span style="color:#888;font-size:9px"> · ${tzLabel}</span>
      ${activePosition ? `<br><span style="color:#f97316">┄</span> Entry <span style="color:#ef4444">┄</span> Stop Loss <span style="color:#22c55e">┄</span> Take Profit` : ''}
    `;
    chartContainerRef.current.style.position = 'relative';
    chartContainerRef.current.appendChild(legend);

    const candlestickSeries = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444"
    });

    // Shift every candle timestamp by the target timezone offset
    const seenTimes = new Set<number>();
    const cdata = candles
      .map(c => ({
        time: shiftTime(c.time as number),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      }))
      .filter(c => {
        const t = c.time as number;
        if (seenTimes.has(t)) return false;
        seenTimes.add(t);
        return true;
      })
      .sort((a, b) => (a.time as number) - (b.time as number));

    candlestickSeries.setData(cdata);

    // Track raw UTC times that made it into the chart (for marker matching)
    const shiftedTimes = new Set<number>(cdata.map(c => c.time as number));

    // Active Position Trade Level Overlays
    if (activePosition) {
      candlestickSeries.createPriceLine({
        price: activePosition.entryPrice,
        color: '#f97316',
        lineWidth: 2,
        lineStyle: 2, // Dashed
        axisLabelVisible: true,
        title: `Entry: $${activePosition.entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 })}`,
      });

      candlestickSeries.createPriceLine({
        price: activePosition.stopLoss,
        color: '#ef4444',
        lineWidth: 2,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `SL: $${activePosition.stopLoss.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 })}`,
      });

      candlestickSeries.createPriceLine({
        price: activePosition.takeProfit,
        color: '#22c55e',
        lineWidth: 2,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `TP: $${activePosition.takeProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 })}`,
      });
    }

    // Plot dynamic markers for paper trade transactions (also shift their timestamps)
    if (trades && trades.length > 0) {
      const seenMarkerTimes = new Set<number>();
      const markers = trades
        .map(t => ({
          time: shiftTime(t.time as number),
          position: t.action === "BUY" ? ("belowBar" as const) : ("aboveBar" as const),
          color: t.action === "BUY" ? "#22c55e" : "#ef4444",
          shape: t.action === "BUY" ? ("arrowUp" as const) : ("arrowDown" as const),
          text: t.action
        }))
        .filter(m => {
          const t = m.time as number;
          // Only plot markers on candles that exist in our shifted dataset
          if (!shiftedTimes.has(t)) return false;
          if (seenMarkerTimes.has(t)) return false;
          seenMarkerTimes.add(t);
          return true;
        })
        .sort((a, b) => (a.time as number) - (b.time as number));
      candlestickSeries.setMarkers(markers);
    }

    // Moving Averages Overlay (Vibrant color palette)
    if (indicators) {
      const getLineData = (seriesValues: number[]) => {
        const seen = new Set<number>();
        return candles
          .map((c, i) => ({
            time: shiftTime(c.time as number),
            value: seriesValues[i]
          }))
          .filter(d => {
            const t = d.time as number;
            if (!Number.isFinite(d.value)) return false;
            if (seen.has(t)) return false;
            seen.add(t);
            return true;
          })
          .sort((a, b) => (a.time as number) - (b.time as number));
      };

      if (indicators.ema9) {
        const ema9Series = chart.addLineSeries({ color: "#f97316", lineWidth: 1, title: "EMA9" });
        ema9Series.setData(getLineData(indicators.ema9));
      }
      if (indicators.ema50) {
        const ema50Series = chart.addLineSeries({ color: "#3b82f6", lineWidth: 1, title: "EMA50" });
        ema50Series.setData(getLineData(indicators.ema50));
      }
    }

    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (legend.parentNode) {
        legend.parentNode.removeChild(legend);
      }
      chart.remove();
    };
  }, [candles, trades, indicators, activePosition, timezone, theme, assetName]);

  return <div ref={chartContainerRef} className="w-full h-[400px]" />;
}
