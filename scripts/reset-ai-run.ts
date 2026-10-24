/** Offline-safe by default: preview only, explicit run/path, loopback Redis only. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  activeAiRun, aiRunKeys, previewAiRunReset, resetAiRun, REQUIRED_AI_RESET_LEASE_KEYS,
  type ActiveAiRun, type AiRunResetPreview,
} from "@/lib/admin/resetAiRun";
import { LocalRedisProxy, setRedisClient, type RawRedisValue, type RedisClient } from "@/lib/redis";

function cashValue(raw: RawRedisValue | undefined, field: string): number | null {
  try {
    const value = raw?.type === "string" ? JSON.parse(raw.value)?.[field] : null;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch { return null; }
}

function parseArgs(args: string[]) {
  const values: Record<string, string> = {};
  let execute = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--execute") { execute = true; continue; }
    if (!["--run-id", "--archive-dir", "--redis-url"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Invalid argument: ${args[i]}`);
    if (values[args[i]]) throw new Error(`Duplicate argument: ${args[i]}`);
    values[args[i]] = args[++i];
  }
  if (!values["--run-id"] || !values["--archive-dir"]) throw new Error("Explicit --run-id and --archive-dir are required; default action is preview");
  aiRunKeys(values["--run-id"]);
  const redisUrl = values["--redis-url"] ?? "redis://127.0.0.1:6379";
  const url = new URL(redisUrl);
  if (url.protocol !== "redis:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("Only unauthenticated loopback Redis is allowed by this CLI");
  return { runId: values["--run-id"], archiveDirectory: values["--archive-dir"], redisUrl, execute };
}

export async function runAiRunResetCli(args: string[], dependencies: {
  redis?: RedisClient; output?: (line: string) => void; acknowledge?: (run: ActiveAiRun) => Promise<void>;
} = {}): Promise<void> {
  const options = parseArgs(args);
  const output = dependencies.output ?? console.log;
  const redis = dependencies.redis ?? new LocalRedisProxy(options.redisUrl);
  if (!dependencies.redis) setRedisClient(redis);
  const leases: Record<string, string> = {};
  let leaveFreeze = false;
  try {
    let preview: AiRunResetPreview;
    if (!options.execute) {
      preview = await previewAiRunReset({ ...options, redis });
    } else {
      // The daemon must honor this freeze while continuing protective exits.
      for (const key of REQUIRED_AI_RESET_LEASE_KEYS) {
        const token = crypto.randomUUID();
        if (await redis.set(key, token, { nx: true, ex: 900 }) !== "OK") throw new Error(`Cannot acquire reset lease: ${key}`);
        leases[key] = token;
      }
      preview = await previewAiRunReset({ ...options, redis });
      const archivePath = path.join(preview.archiveDirectory, `${options.runId}.json`);
      // Resume exactly the durable request, never generate a new capital request on retry.
      if (fs.existsSync(archivePath)) {
        if (fs.lstatSync(archivePath).isSymbolicLink()) throw new Error("Unsafe archive file");
        const saved = JSON.parse(fs.readFileSync(archivePath, "utf8")) as { preview: AiRunResetPreview };
        if (saved.preview.runId !== options.runId || saved.preview.archiveDirectory !== preview.archiveDirectory) throw new Error("Archive run ID/path mismatch");
        preview = saved.preview;
      }
    }
    output(JSON.stringify({
      mode: options.execute ? "EXECUTE" : "PREVIEW", runId: preview.runId, brainVersion: preview.brainVersion,
      canReset: preview.canReset, capital: preview.capital, blockers: preview.blockers,
      requiredPreparation: preview.requiredPreparation, affectedKeys: preview.affectedKeys,
      humanDigest: preview.humanDigest, sourceDigest: preview.sourceDigest, coverage: preview.coverage,
      oldAiCash: cashValue(preview.sources["ai:portfolio"], "usd"),
      oldXsecCash: cashValue(preview.sources["xsec:portfolio"], "cashUsd"),
    }));
    if (options.execute) {
      const run = await resetAiRun({ preview, leases, redis, acknowledge: dependencies.acknowledge });
      output(JSON.stringify({ mode: "COMPLETED", run }));
    }
  } catch (error) {
    const active = options.execute ? await activeAiRun(redis).catch(() => null) : null;
    leaveFreeze = active?.runId === options.runId && await redis.get(aiRunKeys(options.runId).ledgerAcknowledged).catch(() => null) !== true;
    throw error;
  } finally {
    for (const [key, token] of Object.entries(leases).reverse()) {
      if (!(leaveFreeze && key === "brain:v6:migration-freeze")) await redis.compareAndDelete(key, token);
    }
    if (!dependencies.redis) { await redis.quit(); setRedisClient(null); }
  }
}

if (process.argv[1] && /(?:^|[\\/])reset-ai-run\.ts$/.test(process.argv[1])) {
  runAiRunResetCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : "AI run reset failed");
    process.exitCode = 1;
  });
}
