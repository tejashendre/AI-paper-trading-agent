"use client";
import React, { useEffect, useRef } from "react";
import { createChart, ColorType, IChartApi, Time } from "lightweight-charts";

interface Trade {
  timestamp: string;
  pnl?: number;
  action: string;
}

interface Props {
  trades: Trade[];
  initialCapital: number;
}

export function EquityCurve({ trades, initialCapital }: Props) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!chartContainerRef.current || !trades || trades.length === 0) return;

    const chart = createChart(chartContainerRef.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#A3A3A3" },
      grid: { vertLines: { color: "#1a1a1a" }, horzLines: { color: "#1a1a1a" } },
      width: chartContainerRef.current.clientWidth,
      height: 200,
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#262626' },
    });
    chartRef.current = chart;

    // Build equity curve from trade history
    let equity = initialCapital;
    const equityPoints: { time: Time; value: number }[] = [{
      time: (new Date(trades[trades.length - 1]?.timestamp || Date.now()).getTime() / 1000 - 86400) as Time,
      value: initialCapital
    }];

    // Process trades from oldest to newest (they come newest-first from Redis LPUSH)
    const sortedTrades = [...trades].reverse();
    
    for (const trade of sortedTrades) {
      if (trade.pnl !== undefined && trade.pnl !== null) {
        equity += trade.pnl;
        const ts = Math.floor(new Date(trade.timestamp).getTime() / 1000);
        equityPoints.push({ time: ts as Time, value: equity });
      }
    }

    // Determine if profitable overall
    const isProfitable = equity >= initialCapital;

    const areaSeries = chart.addAreaSeries({
      topColor: isProfitable ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)',
      bottomColor: isProfitable ? 'rgba(34, 197, 94, 0.02)' : 'rgba(239, 68, 68, 0.02)',
      lineColor: isProfitable ? '#22c55e' : '#ef4444',
      lineWidth: 2,
    });

    // Deduplicate timestamps
    const deduped: Map<number, number> = new Map();
    for (const pt of equityPoints) {
      deduped.set(pt.time as number, pt.value);
    }
    const finalPoints = Array.from(deduped.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([time, value]) => ({ time: time as Time, value }));

    if (finalPoints.length === 1) {
      // Add a second point at the current time to draw a flat baseline
      finalPoints.push({
        time: Math.floor(Date.now() / 1000) as Time,
        value: finalPoints[0].value
      });
    }

    if (finalPoints.length > 1) {
      areaSeries.setData(finalPoints);
    }

    // Add baseline at initial capital
    areaSeries.createPriceLine({
      price: initialCapital,
      color: '#525252',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: 'Initial Capital',
    });

    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, [trades, initialCapital]);

  return <div ref={chartContainerRef} className="w-full h-[200px]" />;
}
