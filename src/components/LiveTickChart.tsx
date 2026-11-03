"use client";
import React, { useEffect, useRef, useState } from "react";
import { createChart, ColorType, IChartApi, ISeriesApi, IPriceLine, Time, UTCTimestamp } from "lightweight-charts";

/**
 * Live 1-second chart. Builds 1s OHLC candles in the browser from the same
 * Bybit quote stream the dashboard already receives (about every 100 ms), and
 * keeps the most recent hour. Pausing freezes the view while ticks keep being
 * buffered, so resuming shows everything that happened in between.
 */
export const LIVE_WINDOW_SECONDS = 3600;
interface Bar { time: UTCTimestamp; open: number; high: number; low: number; close: number }
interface Props {
  asset: string;
  price: number | null | undefined;
  source?: string;
  updatedAt?: string | null;
  position?: { entryPrice: number; stopLoss: number; takeProfit: number; direction?: "LONG" | "SHORT" } | null;
  theme?: "light" | "dark";
  timezone?: "EU" | "UK" | "IST" | "US";
}

/** Pure bucketing so it can be unit tested: folds a tick into 1s bars and trims to the window. */
export function foldTick(bars: Bar[], price: number, atMs: number, windowSeconds = LIVE_WINDOW_SECONDS): Bar[] {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(atMs)) return bars;
  const t = Math.floor(atMs / 1000) as UTCTimestamp, last = bars.at(-1);
  if (last && t < last.time) return bars;
  const next = last && last.time === t
    ? [...bars.slice(0, -1), { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price }]
    : [...bars, { time: t, open: last?.close ?? price, high: Math.max(price, last?.close ?? price), low: Math.min(price, last?.close ?? price), close: price }];
  const cutoff = t - windowSeconds;
  return next[0].time <= cutoff ? next.filter(b => b.time > cutoff) : next;
}

const zone = (tz: Props["timezone"]) => tz === "IST" ? "Asia/Kolkata" : tz === "US" ? "America/New_York" : tz === "UK" ? "Europe/London" : "Europe/Paris";

export function LiveTickChart({ asset, price, source, updatedAt, position, theme = "dark", timezone = "EU" }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const bars = useRef<Bar[]>([]);
  const [paused, setPaused] = useState(false);
  const [ticks, setTicks] = useState(0);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  // One chart per asset/theme; history starts fresh for a new asset.
  useEffect(() => {
    if (!box.current) return;
    const dark = theme === "dark", tz = zone(timezone);
    const c = createChart(box.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: dark ? "#A3A3A3" : "#586069" },
      grid: { vertLines: { color: dark ? "#1a1a1a" : "#e2e8f0" }, horzLines: { color: dark ? "#1a1a1a" : "#e2e8f0" } },
      width: box.current.clientWidth, height: 400,
      localization: { timeFormatter: (time: Time) => new Date(Number(time) * 1000).toLocaleTimeString("en-GB", { timeZone: tz }) },
      timeScale: { timeVisible: true, secondsVisible: true, rightOffset: 5,
        tickMarkFormatter: (time: Time) => new Date(Number(time) * 1000).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit" }) },
    });
    const s = c.addCandlestickSeries({ upColor: "#22c55e", downColor: "#ef4444", borderVisible: false, wickUpColor: "#22c55e", wickDownColor: "#ef4444" });
    chart.current = c; series.current = s; bars.current = []; lines.current = []; setTicks(0);
    const resize = () => box.current && c.applyOptions({ width: box.current.clientWidth });
    window.addEventListener("resize", resize);
    return () => { window.removeEventListener("resize", resize); c.remove(); chart.current = null; series.current = null; };
  }, [asset, theme, timezone]);

  // Fold every quote into the current 1s bar; render only while not paused.
  useEffect(() => {
    if (typeof price !== "number") return;
    const before = bars.current.length, at = Date.now();
    bars.current = foldTick(bars.current, price, at);
    setTicks(n => n + 1);
    const s = series.current;
    if (!s || pausedRef.current) return;
    const last = bars.current.at(-1);
    if (!last) return;
    // A trimmed window needs a full redraw; otherwise a cheap in-place update.
    if (bars.current.length < before) s.setData(bars.current); else s.update(last);
  }, [price, updatedAt]);

  useEffect(() => { if (!paused && series.current) { series.current.setData(bars.current); chart.current?.timeScale().scrollToRealTime(); } }, [paused]);

  // The bot's open position, drawn as entry / stop / target lines.
  const entry = position?.entryPrice, stop = position?.stopLoss, target = position?.takeProfit, side = position?.direction;
  useEffect(() => {
    const s = series.current; if (!s) return;
    for (const l of lines.current) s.removePriceLine(l);
    lines.current = entry === undefined || stop === undefined || target === undefined ? [] : [
      s.createPriceLine({ price: entry, color: "#3b82f6", lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: `BOT ${side ?? ""} ENTRY` }),
      s.createPriceLine({ price: stop, color: "#ef4444", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "STOP" }),
      s.createPriceLine({ price: target, color: "#22c55e", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "TARGET" }),
    ];
  }, [entry, stop, target, side, asset, theme, timezone]);

  const seconds = bars.current.length, live = source === "WEBSOCKET";
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[10px] font-mono">
        <button onClick={() => setPaused(p => !p)} className="rounded border px-3 py-1 font-bold">
          {paused ? "▶ Resume live" : "❚❚ Pause"}
        </button>
        <span className={live ? "text-green-500" : "text-amber-500"}>{live ? "● LIVE WebSocket" : "● REST fallback"}</span>
        <span>{asset} {typeof price === "number" ? price.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "—"}</span>
        <span>{ticks.toLocaleString()} ticks · {Math.floor(seconds / 60)}m {seconds % 60}s of 60m window</span>
        {paused && <span className="text-amber-500">Paused: still recording, resume to catch up</span>}
        {position && <span className="text-blue-500">Bot position open: entry / stop / target shown</span>}
      </div>
      <div ref={box} className="relative w-full" />
    </div>
  );
}
