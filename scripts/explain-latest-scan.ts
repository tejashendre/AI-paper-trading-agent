#!/usr/bin/env npx tsx
/**
 * Explain the latest swing scan in plain English.
 *
 * This is read-only and uses the public/spectator status API by default.
 */

import * as http from "http";
import * as https from "https";

const STATUS_URL = process.env.STATUS_URL || "https://trader.tejashendre.com/api/user/status";
const STATUS_AUTH_TOKEN = process.env.STATUS_AUTH_TOKEN || "SPECTATOR";

type RawRecord = Record<string, unknown>;

interface StatusData extends RawRecord {
  swingScan?: {
    completedAt?: string;
    results?: RawRecord[];
  };
  aiPortfolio?: unknown;
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
            } catch {
              reject(new Error("Failed to parse JSON response"));
            }
          } else {
            reject(new Error(`API returned status code ${res.statusCode}`));
          }
        });
      }
    );

    req.on("error", reject);
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

function countOpenPositions(source: unknown): number {
  if (Array.isArray(source)) {
    return source.filter((item) => Math.abs(asNumber(asRecord(item).quantity) ?? asNumber(asRecord(item).size) ?? 0) > 0).length;
  }

  const record = asRecord(source);
  const directCount = asNumber(record.openPositionsCount) ?? asNumber(record.openPositionCount);
  if (directCount !== undefined) return directCount;

  const buckets = [record.positions, record.swingPositions, record.scalpPositions, record.activePositions, record.openPositions];
  return buckets
    .flatMap((bucket) => {
      if (Array.isArray(bucket)) return bucket;
      const keyed = asRecord(bucket);
      return Object.keys(keyed).length > 0 ? Object.values(keyed) : [];
    })
    .filter((item) => {
      const position = asRecord(item);
      return Math.abs(asNumber(position.quantity) ?? asNumber(position.size) ?? asNumber(position.amount) ?? 0) > 0;
    }).length;
}

function getText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function explainReason(result: RawRecord): string {
  const gate = asRecord(result.entryGate);
  return (
    getText(result.simpleStatus) ||
    getText(result.simpleReason) ||
    getText(result.nextStep) ||
    getText(result.reason) ||
    getText(result.explanation) ||
    getText(gate.primaryBlocker) ||
    "No public reason supplied by the scan result."
  );
}

function colorForAction(action: string): string {
  if (action === "ENTRY") return "\x1b[32m";
  if (action === "HOLD") return "\x1b[34m";
  if (action === "BLOCKED") return "\x1b[31m";
  if (action === "SKIPPED") return "\x1b[33m";
  return "\x1b[37m";
}

async function main(): Promise<void> {
  console.log("\x1b[36m%s\x1b[0m", "Fetching latest scan data from the agent...");

  let data: StatusData;
  try {
    data = await fetchStatus();
  } catch (error) {
    console.error("\x1b[31m%s\x1b[0m", `Failed to fetch status: ${(error as Error).message}`);
    process.exit(1);
  }

  const swingScan = data.swingScan;
  const results = Array.isArray(swingScan?.results) ? swingScan.results : [];

  if (!swingScan || results.length === 0) {
    console.log("\x1b[33m%s\x1b[0m", "No active scan results found. The system may be resting or data feeds may be down.");
    return;
  }

  const counts = { ENTRY: 0, HOLD: 0, BLOCKED: 0, SKIPPED: 0 };

  console.log(`\n\x1b[1m=== LATEST SCAN EXPLANATION (${new Date(swingScan.completedAt || Date.now()).toLocaleString()}) ===\x1b[0m\n`);

  for (const result of results) {
    const asset = getText(result.asset) || "UNKNOWN";
    const action = getText(result.action) || "UNKNOWN";
    if (action in counts) counts[action as keyof typeof counts] += 1;

    console.log(`${colorForAction(action)}\x1b[1m[${asset}] - ${action}\x1b[0m`);
    console.log(`  Reason: \x1b[3m${explainReason(result)}\x1b[0m`);

    const gate = asRecord(result.entryGate);
    if (action === "BLOCKED" && getText(gate.primaryBlocker)) {
      console.log(`  Blocker: \x1b[31m${getText(gate.primaryBlocker)}\x1b[0m`);
    }

    const finalConviction = asNumber(result.finalConviction);
    if (finalConviction !== undefined) console.log(`  Conviction: ${finalConviction}/100`);

    const dataQuality = asNumber(result.dataQuality);
    if (dataQuality !== undefined) console.log(`  Data quality score: ${dataQuality}`);

    console.log("");
  }

  console.log("\x1b[1m=== SUMMARY ===\x1b[0m");
  const actionText = counts.ENTRY > 0 ? "\x1b[32mTRADING\x1b[0m" : "\x1b[33mWAITING\x1b[0m";
  console.log(`The bot is currently ${actionText}. ${results.length} assets are being watched.`);
  console.log(`Results breakdown: ${counts.ENTRY} entries, ${counts.HOLD} holds, ${counts.BLOCKED} blocked setups, ${counts.SKIPPED} skipped setups.`);
  console.log(`Portfolio is currently managing ${countOpenPositions(data.aiPortfolio)} open position(s).`);
  console.log("\n\x1b[32mOK: The command is read-only and the system is running in paper-trading mode.\x1b[0m\n");
}

main().catch((error) => {
  console.error("\x1b[31m%s\x1b[0m", `Fatal error: ${(error as Error).message}`);
  process.exit(1);
});
