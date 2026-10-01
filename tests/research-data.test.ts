import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { outcomes, definition } from "./helpers/researchFixtures";

test("insufficient_history_and_purging_are_explicit", async () => {
  const r: any = await import("../src/lib/research/candidateRegistry").catch(() => ({}));
  assert.equal(typeof r.buildPurgedOutcomeFolds, "function");
  assert.equal(r.buildPurgedOutcomeFolds(outcomes(51), definition.labelHorizonMs).length, 0);
  const clean = r.buildPurgedOutcomeFolds(outcomes(52), definition.labelHorizonMs);
  assert.equal(clean.length, 1);
  assert.equal(clean[0].train.length, 30);
  assert.equal(clean[0].validation.length, 10);
  assert.equal(clean[0].test.length, 10);
  const overlapping = outcomes(52).map(o => ({ ...o, featureStartMs: definition.registeredAtMs }));
  assert.equal(r.buildPurgedOutcomeFolds(overlapping, definition.labelHorizonMs).length, 0);
});
test("research archive is lossless, bounded, deduplicated and never deletes evidence", async () => {
  const archive: any = await import("../src/lib/research/researchArchive").catch(() => ({}));
  assert.equal(typeof archive.appendResearchEvidence, "function");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bybit-research-test-"));
  const record = { asset: "BTC", recordedAtMs: Date.parse("2026-10-01T00:00:00Z"),
    candles: { "15m": [{ time: 1790811900, open: 100, high: 101, low: 99, close: 100, volume: 10 }] },
    quote: { price: 100 }, metadata: { symbol: "BTCUSDT", metadataVersion: "hash" } };
  const first = archive.appendResearchEvidence({ directory, record, maxBytes: 5000 });
  assert.equal(first.status, "CAPTURED");
  assert.equal(archive.appendResearchEvidence({ directory, record, maxBytes: 5000 }).status, "UNCHANGED");
  const files = fs.readdirSync(directory).filter(f => f.endsWith(".gz"));
  const before = fs.readFileSync(path.join(directory, files[0]));
  const parsed = JSON.parse(gunzipSync(before).toString("utf8").trim());
  assert.equal(parsed.record.candles["15m"][0].close, 100);
  const stopped = archive.appendResearchEvidence({ directory, record: { ...record, recordedAtMs: record.recordedAtMs + 900000,
    quote: { price: 101 } }, maxBytes: before.length });
  assert.equal(stopped.status, "STORAGE_LIMIT");
  assert.deepEqual(fs.readFileSync(path.join(directory, files[0])), before);
});
