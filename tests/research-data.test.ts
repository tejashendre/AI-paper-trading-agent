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
test("research archive is lossless, bounded, deduplicated and never deletes the day being written", async () => {
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

test("a full research archive rotates out its oldest days instead of stopping capture", async () => {
  // Storage option 1 (Tejas, 2026-10-02): the archive stays within its cap,
  // and a self-learning bot needs the newest evidence most.
  const archive: any = await import("../src/lib/research/researchArchive");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bybit-research-rotate-"));
  const day = (d: number) => Date.parse(`2026-10-0${d}T00:00:00Z`);
  const record = (d: number) => ({ asset: "BTC", recordedAtMs: day(d),
    candles: { "15m": [{ time: day(d) / 1000, open: 100 + d, high: 101 + d, low: 99 + d, close: 100 + d, volume: 10 }] },
    quote: { price: 100 + d }, metadata: { symbol: "BTCUSDT", metadataVersion: "hash", padding: "x".repeat(400) } });
  archive.appendResearchEvidence({ directory, record: record(1), maxBytes: 100_000 });
  archive.appendResearchEvidence({ directory, record: record(2), maxBytes: 100_000 });
  // Everything stored now (both days plus capture state) is exactly the cap
  // plus a little, so a third day fits only after the oldest rotates out.
  const stored = fs.readdirSync(directory).reduce((sum: number, f: string) => sum + fs.statSync(path.join(directory, f)).size, 0);
  const third = archive.appendResearchEvidence({ directory, record: record(3), maxBytes: stored + 50 });
  assert.equal(third.status, "CAPTURED");
  assert.deepEqual(third.rotatedOut, ["2026-10-01.ndjson.gz"]);
  assert.deepEqual(fs.readdirSync(directory).filter((f: string) => f.endsWith(".gz")).sort(), ["2026-10-02.ndjson.gz", "2026-10-03.ndjson.gz"]);
  assert.equal(archive.readResearchEvidence(directory).length, 2, "what remains still verifies");
});
