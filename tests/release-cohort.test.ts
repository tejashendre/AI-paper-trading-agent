import test from "node:test";
import assert from "node:assert/strict";
import { TRADING_STRATEGY_VERSION } from "@/lib/trading/executionLedger";
import { LocalLearningMemory } from "@/lib/trading/localLearning";
import { OpportunityJournal } from "@/lib/trading/opportunityJournal";
import { TradeReviewJournal } from "@/lib/trading/tradeReviewJournal";
import { setRedisClient } from "@/lib/redis";
import { MemoryRedis } from "./helpers/memoryRedis";

test("the changed Bybit data and cost model starts a separate strategy cohort", async () => {
  const oldVersion = "swing-v4.2.0-2026-08-04";
  const redis = new MemoryRedis();
  const oldRules = [{ id: "old-gold-veto", action: "WATCH_ONLY", key: "GOLD" }];
  const oldSummary = { totalEvaluated: 99, byAsset: { GOLD: { total: 99 } } };
  const oldReviews = [{ id: "old-review", strategyVersion: oldVersion }];
  await redis.set(`learning:${oldVersion}:localRules`, oldRules);
  await redis.set(`opportunity:${oldVersion}:v3:summary`, oldSummary);
  await redis.lpush(`tradeReview:${oldVersion}:aiSwing`, JSON.stringify(oldReviews[0]));
  setRedisClient(redis);
  try {
    assert.notEqual(TRADING_STRATEGY_VERSION, oldVersion);
    assert.deepEqual(await LocalLearningMemory.getRules(), []);
    assert.equal((await OpportunityJournal.getSummary()).totalEvaluated, 0);
    assert.deepEqual(await TradeReviewJournal.getRecent(), []);
    assert.deepEqual(await redis.get(`learning:${oldVersion}:localRules`), oldRules);
    assert.deepEqual(await redis.get(`opportunity:${oldVersion}:v3:summary`), oldSummary);
    assert.equal((await redis.lrange(`tradeReview:${oldVersion}:aiSwing`, 0, -1)).length, 1);
  } finally {
    setRedisClient(null);
  }
});
