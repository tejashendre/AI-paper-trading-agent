import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setRedisClient, getRedis } from "@/lib/redis";
import { MemoryRedis } from "./helpers/memoryRedis";
import { PortfolioManager } from "@/lib/portfolio";
import { normalizeResetCapital, resetHumanPortfolio } from "@/lib/admin/resetHuman";

test("human reset clears only the human portfolio, even during an active AI run", async (t) => {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "human-reset-"));
  process.chdir(dir);
  setRedisClient(new MemoryRedis());
  t.after(() => { process.chdir(cwd); setRedisClient(null); });

  const redis = getRedis();
  await redis.set("user:portfolio", { usd: 1, initialCapital: 10_000, openPositions: { BTC: { amount: 1 } }, scalpPositions: {} });
  await redis.set("ai:portfolio", { usd: 777, initialCapital: 10_000, openPositions: {}, scalpPositions: {} });
  await redis.set("brain:v6:activeRun", { runId: "run1" });
  await redis.lpush("user:trades", JSON.stringify({ id: "t1" }));
  await redis.lpush("user:positionOutcomes", JSON.stringify({ id: "o1" }));

  const result = await resetHumanPortfolio({ capital: 25_000, source: "TEST" });

  assert.equal(result.capital, 25_000);
  assert.equal(result.discardedOpenPositions, 1);
  const user = await redis.get<{ usd: number; openPositions: object }>("user:portfolio");
  assert.equal(user?.usd, 25_000);
  assert.deepEqual(user?.openPositions, {});
  assert.deepEqual(await redis.lrange("user:trades", 0, -1), []);
  assert.deepEqual(await redis.lrange("user:positionOutcomes", 0, -1), []);
  assert.equal((await redis.get<{ usd: number }>("ai:portfolio"))?.usd, 777);
  assert.notEqual(await redis.get("brain:v6:activeRun"), null);
  assert.equal((await PortfolioManager.getPortfolio("user")).usd, 25_000);
});

test("reset capital outside the allowed range falls back to the default", () => {
  assert.equal(normalizeResetCapital(50), 10_000);
  assert.equal(normalizeResetCapital(Number.NaN), 10_000);
  assert.equal(normalizeResetCapital("5000"), 10_000);
  assert.equal(normalizeResetCapital(5_000), 5_000);
});
