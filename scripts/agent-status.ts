#!/usr/bin/env npx tsx
/**
 * Agent Status CLI - read-only terminal dashboard for the live paper agent.
 *
 * Environment variables:
 *   STATUS_URL        defaults to https://ai-quant-trader.duckdns.org/api/user/status
 *   STATUS_AUTH_TOKEN defaults to SPECTATOR
 */

import * as http from "http";
import * as https from "https";

const STATUS_URL = process.env.STATUS_URL || "https://trader.tejashendre.com/api/user/status";
const STATUS_AUTH_TOKEN = process.env.STATUS_AUTH_TOKEN || "SPECTATOR";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[91m",
  green: "\x1b[92m",
  yellow: "\x1b[93m",
  blue: "\x1b[94m",
  cyan: "\x1b[96m",
  white: "\x1b[97m",
};

type RawRecord = Record<string, unknown>;

interface NormalizedPosition {
  asset: string;
  quantity: number;
  avgPrice?: number;
  direction?: string;
  margin?: number;
  pnl?: number;
  thesisStatus?: string;
  thesisReason?: string;
  scaleInBlockedReason?: string;
}

interface StatusData extends RawRecord {
  aiPortfolio?: unknown;
  portfolio?: unknown;
  aiTrades?: unknown[];
  userTrades?: unknown[];
  aiTotalValue?: number;
  userTotalValue?: number;
  btcPrice?: number;
  swingScan?: {
    scanId?: string | number;
    completedAt?: string;
    results?: Array<RawRecord>;
  };
  feedHealthMatrix?: {
    assets?: Array<{ asset?: string; status?: string; score?: number }>;
    summary?: { good?: number; degraded?: number; bad?: number };
  };
  learningDigest?: {
    headline?: string;
    totalEvaluated?: number;
    favorableRate?: number;
    activeRules?: number;
    bestSetup?: string;
  };
}

function styled(text: string, ...styles: string[]): string {
  return styles.join("") + text + c.reset;
}

function fetchStatus(): Promise<StatusData> {
  return new Promise((resolve, reject) => {
    const url = new URL(STATUS_URL);
    const transport = url.protocol === "https:" ? https : http;

    const req = transport.get(
      url,
      {
        headers: {
          Authorization: `Bearer ${STATUS_AUTH_TOKEN}`,
          Accept: "application/json",
        },
        timeout: 15000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data) as StatusData);
            } catch (error) {
              reject(new Error(`JSON parse error: ${(error as Error).message}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      }
    );

    req.on("error", (error) => reject(new Error(`Network error: ${error.message}`)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });
}

function asRecord(value: unknown): RawRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawRecord) : {};
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizePosition(value: unknown): NormalizedPosition | null {
  const item = asRecord(value);
  const asset = typeof item.asset === "string" ? item.asset : typeof item.symbol === "string" ? item.symbol : "UNKNOWN";
  const quantity = asNumber(item.quantity) ?? asNumber(item.size) ?? asNumber(item.amount) ?? 0;
  const avgPrice = asNumber(item.avgPrice) ?? asNumber(item.entryPrice) ?? asNumber(item.entry);
  const margin = asNumber(item.margin) ?? asNumber(item.usedMargin);
  const pnl = asNumber(item.unrealizedPnl) ?? asNumber(item.pnl);
  const direction = typeof item.direction === "string" ? item.direction : typeof item.side === "string" ? item.side : undefined;
  const thesisStatus = typeof item.thesisStatus === "string" ? item.thesisStatus : undefined;
  const thesisReason = typeof item.thesisReason === "string" ? item.thesisReason : undefined;
  const scaleInBlockedReason = typeof item.scaleInBlockedReason === "string" ? item.scaleInBlockedReason : undefined;

  if (!asset || Math.abs(quantity) <= 0) return null;
  return { asset, quantity, avgPrice, direction, margin, pnl, thesisStatus, thesisReason, scaleInBlockedReason };
}

function collectPositions(source: unknown): NormalizedPosition[] {
  if (Array.isArray(source)) {
    return source.map(normalizePosition).filter((position): position is NormalizedPosition => Boolean(position));
  }

  const record = asRecord(source);
  const candidates = [
    record.positions,
    record.swingPositions,
    record.scalpPositions,
    record.activePositions,
    record.openPositions,
    record.holdings,
  ];

  return candidates
    .flatMap((items) => {
      if (Array.isArray(items)) return items;
      const keyed = asRecord(items);
      return Object.keys(keyed).length > 0 ? Object.values(keyed) : [];
    })
    .map(normalizePosition)
    .filter((position): position is NormalizedPosition => Boolean(position));
}

function countTrades(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function sumRealizedPnl(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.reduce((sum, trade) => {
    const item = asRecord(trade);
    return sum + (asNumber(item.realizedPnl) ?? asNumber(item.pnl) ?? 0);
  }, 0);
}

function section(title: string): void {
  console.log("");
  console.log(styled(`== ${title} ==`, c.bold, c.blue));
}

function kv(key: string, value: string): void {
  console.log(`${styled(`${key}:`, c.dim)} ${value}`);
}

function formatCurrency(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return styled("N/A", c.dim);
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatSetup(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  const record = asRecord(value);
  return (
    (typeof record.label === "string" && record.label) ||
    (typeof record.key === "string" && record.key) ||
    (typeof record.setup === "string" && record.setup) ||
    (typeof record.name === "string" && record.name) ||
    (typeof record.primarySetup === "string" && record.primarySetup) ||
    "No setup name supplied"
  );
}

function scanAge(completedAt?: string): string {
  if (!completedAt) return "unknown";
  const ageMs = Date.now() - new Date(completedAt).getTime();
  if (!Number.isFinite(ageMs)) return "unknown";
  const ageMin = Math.max(0, Math.round(ageMs / 60000));
  if (ageMin < 60) return `${ageMin}m ago`;
  if (ageMin < 1440) return `${Math.round(ageMin / 60)}h ago`;
  return `${Math.round(ageMin / 1440)}d ago`;
}

async function main(): Promise<void> {
  console.log(styled("\nAutonomous Paper Trading Agent - Status", c.bold, c.cyan));
  console.log(styled(new Date().toISOString(), c.dim));

  section("Dashboard API");
  let status: StatusData;
  try {
    status = await fetchStatus();
    kv("Status", styled("connected", c.green));
    kv("Endpoint", styled(STATUS_URL, c.dim));
  } catch (error) {
    kv("Status", styled("error", c.red));
    kv("Detail", styled((error as Error).message, c.red));
    process.exit(1);
  }

  const aiPositions = collectPositions(status.aiPortfolio);
  const humanPositions = collectPositions(status.portfolio);
  const aiRealizedPnl = sumRealizedPnl(status.aiTrades);

  section("AI Portfolio");
  kv("Total value", styled(formatCurrency(status.aiTotalValue), c.bold));
  kv("Realized PnL", styled(formatCurrency(aiRealizedPnl), aiRealizedPnl >= 0 ? c.green : c.red));
  kv("Open positions", styled(String(aiPositions.length), c.white));
  kv("Closed/detail trades returned", styled(String(countTrades(status.aiTrades)), c.white));

  if (aiPositions.length > 0) {
    for (const position of aiPositions) {
      const details = [
        position.direction ? `side=${position.direction}` : null,
        `qty=${position.quantity}`,
        position.avgPrice !== undefined ? `entry=${formatCurrency(position.avgPrice)}` : null,
        position.margin !== undefined ? `margin=${formatCurrency(position.margin)}` : null,
        position.pnl !== undefined ? `pnl=${formatCurrency(position.pnl)}` : null,
        position.thesisStatus ? `thesis=${position.thesisStatus}` : null,
      ].filter(Boolean);
      console.log(`  - ${position.asset}: ${details.join(" | ")}`);
      if (position.thesisReason) console.log(`    ${styled(position.thesisReason, c.dim)}`);
      if (position.scaleInBlockedReason) console.log(`    ${styled(position.scaleInBlockedReason, c.yellow)}`);
    }
  }

  section("Human Portfolio");
  kv("Total value", styled(formatCurrency(status.userTotalValue), c.bold));
  kv("Open positions", styled(String(humanPositions.length), c.white));
  kv("Closed/detail trades returned", styled(String(countTrades(status.userTrades)), c.white));

  section("Latest Swing Scan");
  const scan = status.swingScan;
  const results = Array.isArray(scan?.results) ? scan.results : [];
  kv("Scan ID", styled(String(scan?.scanId ?? "none"), c.white));
  kv("Completed", styled(`${scan?.completedAt ?? "unknown"} (${scanAge(scan?.completedAt)})`, c.white));
  kv("Entries", styled(String(results.filter((result) => result.action === "ENTRY").length), c.green));
  kv("Holds", styled(String(results.filter((result) => result.action === "HOLD").length), c.yellow));
  kv("Blocked", styled(String(results.filter((result) => result.action === "BLOCKED").length), c.red));
  kv("Skipped", styled(String(results.filter((result) => result.action === "SKIPPED").length), c.dim));

  section("Feed Health");
  const summary = status.feedHealthMatrix?.summary;
  if (summary) {
    kv("Good", styled(String(summary.good ?? 0), c.green));
    kv("Degraded", styled(String(summary.degraded ?? 0), (summary.degraded ?? 0) > 0 ? c.yellow : c.green));
    kv("Bad", styled(String(summary.bad ?? 0), (summary.bad ?? 0) > 0 ? c.red : c.green));
  } else {
    kv("Status", styled("No feed health data returned", c.dim));
  }

  section("Learning");
  const digest = status.learningDigest;
  if (digest) {
    kv("Headline", styled(digest.headline ?? "No headline supplied", c.white));
    kv("Evaluated opportunities", styled(String(digest.totalEvaluated ?? 0), c.white));
    kv("Active rules", styled(String(digest.activeRules ?? 0), c.cyan));
    if (typeof digest.favorableRate === "number") {
      kv("Favorable rate", styled(`${(digest.favorableRate * 100).toFixed(1)}%`, c.white));
    }
    if (digest.bestSetup) kv("Best setup", styled(formatSetup(digest.bestSetup), c.green));
  } else {
    kv("Status", styled("No learning digest returned", c.dim));
  }

  console.log(styled("\nPaper trading only - read-only status command.\n", c.bold, c.green));
}

main().catch((error) => {
  console.error(styled(`\nFatal error: ${(error as Error).message}`, c.red));
  process.exit(1);
});
