"use client";
import React, { useEffect, useRef } from "react";
import { createChart, ColorType, IChartApi, Time, TickMarkType } from "lightweight-charts";
import { formatChartTime } from '@/lib/ui/chartHistory';
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

export function TradingChart({ candles, trades, indicators, activePosition, assetName, timezone = 'EU', theme = 'dark' }: Props) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const viewportRef = useRef<{ from: Time; to: Time } | null>(null);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const isDark = theme === 'dark';
    const textColor = isDark ? "#A3A3A3" : "#586069";
    const gridColor = isDark ? "#1a1a1a" : "#e2e8f0";

    const ianaTimezone =
      timezone === 'IST' ? 'Asia/Kolkata'
      : timezone === 'US'  ? 'America/New_York'
      : timezone === 'UK'  ? 'Europe/London'
      : 'Europe/Paris'; // EU default

    const chartTime = (utcSec: number): Time => utcSec as Time;
    const utcSeconds = (time: Time) => typeof time === 'number' ? time :
      typeof time === 'string' ? Date.parse(time) / 1000 : Date.UTC(time.year, time.month - 1, time.day) / 1000;

    const chart = createChart(chartContainerRef.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor },
      grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
      width: chartContainerRef.current.clientWidth,
      height: 400,
      localization: { timeFormatter: (time: Time) => formatChartTime(utcSeconds(time), ianaTimezone) },
      timeScale: { timeVisible: true, secondsVisible: false,
        tickMarkFormatter: (time: Time, type: TickMarkType) => formatChartTime(utcSeconds(time), ianaTimezone,
          type === 0 ? 'year' : type === 1 ? 'month' : type === 2 ? 'date' : 'clock') },
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

    // Keep UTC coordinates for candles, indicators and trade markers.
    const seenTimes = new Set<number>();
    const cdata = candles
      .map(c => ({
        time: chartTime(c.time as number),
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
    const saved = viewportRef.current;
    if (saved && cdata.length && Number(saved.from) >= Number(cdata[0].time) && Number(saved.to) <= Number(cdata.at(-1)!.time)) {
      chart.timeScale().setVisibleRange(saved);
    } else if (cdata.length) {
      chart.timeScale().setVisibleRange({ from: cdata[Math.max(0, cdata.length - 120)].time, to: cdata.at(-1)!.time });
    }

    // Track raw UTC times that made it into the chart (for marker matching)
    const chartTimes = new Set<number>(cdata.map(c => c.time as number));

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

    // Plot paper transactions against the same UTC coordinates.
    if (trades && trades.length > 0) {
      const seenMarkerTimes = new Set<number>();
      const markers = trades
        .map(t => ({
          time: chartTime(t.time as number),
          position: t.action === "BUY" ? ("belowBar" as const) : ("aboveBar" as const),
          color: t.action === "BUY" ? "#22c55e" : "#ef4444",
          shape: t.action === "BUY" ? ("arrowUp" as const) : ("arrowDown" as const),
          text: t.action
        }))
        .filter(m => {
          const t = m.time as number;
          // Only plot markers on candles that exist in the loaded dataset.
          if (!chartTimes.has(t)) return false;
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
            time: chartTime(c.time as number),
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
      viewportRef.current = chart.timeScale().getVisibleRange();
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, trades, indicators, activePosition, timezone, theme, assetName]);

  return <div ref={chartContainerRef} className="w-full h-[400px]" />;
}
