/**
 * The label queue held one baseline record per scan per asset whenever price
 * moved 0.15%, about 244 an hour, so it reached its 4,096 cap every day and
 * then refused new observations, including the strategy-family candidates
 * promotion depends on. Its summary also read 24-hour labels from a list
 * that short-horizon labels flushed within about an hour and a half.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryRedis } from "./helpers/memoryRedis";
import { setRedisClient } from "@/lib/redis";
import { OPPORTUNITY_KEYS, OpportunityJournal } from "@/lib/trading/opportunityJournal";

const baseline = (asset: string, timestamp: string, price: number) => ({
  asset, timestamp, action: "HOLD", decisionState: "WATCH_LONG", price, stopLoss: price * 0.95, takeProfit: price * 1.1,
  finalConviction: 50, setupTags: ["X"],
});
const pending = (memory: MemoryRedis) => memory.listRows(OPPORTUNITY_KEYS.pending).map((raw) => JSON.parse(raw));

describe("opportunity queue capacity", () => {
  it("records one baseline observation per asset, direction and 15-minute bar", async () => {
    const memory = new MemoryRedis();
    setRedisClient(memory);
    try {
      const bar = Date.UTC(2026, 9, 2, 9, 0);
      for (let minute = 0; minute < 15; minute++) {
        await OpportunityJournal.recordMany([baseline("BTC", new Date(bar + minute * 60_000).toISOString(), 100 + minute)]);
      }
      assert.equal(pending(memory).length, 1, "same bar, same direction");
      await OpportunityJournal.recordMany([baseline("BTC", new Date(bar + 15 * 60_000).toISOString(), 120)]);
      assert.equal(pending(memory).length, 2, "the next bar is new evidence");
      await OpportunityJournal.recordMany([baseline("ETH", new Date(bar + 15 * 60_000).toISOString(), 120)]);
      assert.equal(pending(memory).length, 3, "other assets are independent");
    } finally {
      setRedisClient(null);
    }
  });

  it("a strategy candidate displaces the oldest baseline record instead of being refused", async () => {
    const memory = new MemoryRedis();
    setRedisClient(memory);
    try {
      const rows = Array.from({ length: 4096 }, (_, i) => JSON.stringify({ id: `base-${i}`, asset: "BTC", direction: "LONG",
        timestamp: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(), entryPrice: 100, setupTags: [], evaluatedHorizons: [] }));
      for (const row of rows) await memory.lpush(OPPORTUNITY_KEYS.pending, row);
      await OpportunityJournal.recordMany([{ asset: "GOLD", candidateId: "cand-1", family: "RANGE_REVERSION", configHash: "c",
        timestamp: new Date().toISOString(), action: "WATCH", decisionState: "WATCH_LONG", price: 100, stopLoss: 95, takeProfit: 110, finalConviction: 50 }]);
      const queue = pending(memory);
      assert.equal(queue.length, 4096);
      assert.ok(queue.some((row) => row.candidateId === "cand-1"), "the candidate was refused");
      assert.ok(!queue.some((row) => row.id === "base-0"), "the oldest baseline record was not the one displaced");
    } finally {
      setRedisClient(null);
    }
  });

  it("the summary keeps 24-hour labels no matter how many short-horizon labels follow", async () => {
    const memory = new MemoryRedis();
    setRedisClient(memory);
    try {
      const evaluation = (i: number, horizon: string) => JSON.stringify({ id: `e-${horizon}-${i}`, opportunityId: `o-${i}`, asset: "BTC", horizon,
        direction: "LONG", entryPrice: 100, currentPrice: 101, movePercent: 1, maxFavorableExcursion: 1, maxAdverseExcursion: 0,
        hitTakeProfit: false, hitStopLoss: false, firstHit: "NONE", hypotheticalOutcome: "OPEN", favorable: true, netPnlUsd: 1, netReturnPercent: 1, setupTags: ["X"] });
      for (let i = 0; i < 50; i++) await memory.lpush(OPPORTUNITY_KEYS.evaluations24h, evaluation(i, "24h"));
      for (let i = 0; i < 1000; i++) await memory.lpush(OPPORTUNITY_KEYS.evaluations, evaluation(i, "15m"));
      await OpportunityJournal.rebuildSummary();
      assert.equal((await OpportunityJournal.getSummary()).totalEvaluated, 50);
    } finally {
      setRedisClient(null);
    }
  });
});
