import fs from 'node:fs';
import path from 'node:path';
import type { Trade } from '@/lib/types';

/**
 * Self-learning risk allocation, with no LLM.
 *
 * Every closed AI trade is reduced to one number: its realised R (net PnL
 * divided by the risk taken at entry). Results are grouped by asset and
 * direction, and recent trades count more (60-day half-life). Trades from the
 * pre-v6 strategies count at half weight. A Bayesian shrinkage toward zero
 * edge stops a handful of lucky or unlucky trades from swinging the allocation:
 *
 *   meanR = sum(w*R) / (sum(w) + PRIOR_WEIGHT)
 *
 * The result scales the next entry's risk between 0.5x and 1.5x. A pair whose
 * evidence is clearly losing (enough trades and meanR <= -0.3R) is paused
 * until new results, or time decay, lift it again.
 */
export interface LearningSample { asset: string; direction: 'LONG' | 'SHORT'; r: number; closedAtMs: number; weight: number; source: 'V6' | 'LEGACY' }
export interface LearningCell {
  asset: string; direction: 'LONG' | 'SHORT'; trades: number; effectiveTrades: number;
  winRate: number | null; meanR: number; riskMultiplier: number; paused: boolean; reason: string;
}
export interface LearningBook { version: 'v6-learning-1'; generatedAtMs: number; sampleCount: number; cells: LearningCell[] }

export const LEARNING_HALF_LIFE_MS = 60 * 86_400_000;
export const PRIOR_WEIGHT = 5;
export const LEGACY_WEIGHT = 0.5;
export const PAUSE_MIN_EFFECTIVE = 6;
export const PAUSE_MEAN_R = -0.3;
const MIN_MULT = 0.5, MAX_MULT = 1.5, R_FLOOR = -3, R_CAP = 6;

const exitAction = (a: Trade['action']) => a === 'SELL' || a === 'COVER' || a === 'SCALP_SELL' || a === 'SCALP_COVER';

/** Converts closed exit legs into R samples. Legs lacking a usable risk basis are ignored, never guessed. */
export function samplesFromTrades(trades: readonly Trade[], source: LearningSample['source']): LearningSample[] {
  const out: LearningSample[] = [];
  for (const t of trades) {
    if (!t || !exitAction(t.action) || !Number.isFinite(t.pnl)) continue;
    const risk = [t.initialRiskUsdt, t.riskAmountUsd, t.maxLossUsd].find(v => typeof v === 'number' && Number.isFinite(v) && v > 0);
    const closedAtMs = Date.parse(t.timestamp);
    if (!risk || !Number.isFinite(closedAtMs)) continue;
    const direction = t.direction ?? (t.action === 'COVER' || t.action === 'SCALP_COVER' ? 'SHORT' : 'LONG');
    const r = Math.max(R_FLOOR, Math.min(R_CAP, t.pnl! / risk));
    out.push({ asset: t.asset, direction, r, closedAtMs, weight: source === 'LEGACY' ? LEGACY_WEIGHT : 1, source });
  }
  return out;
}

export function buildLearningBook(samples: readonly LearningSample[], nowMs: number): LearningBook {
  const groups = new Map<string, LearningSample[]>();
  for (const s of samples) {
    if (!Number.isFinite(s.r) || !Number.isFinite(s.closedAtMs) || s.closedAtMs > nowMs) continue;
    const key = `${s.asset}|${s.direction}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const cells: LearningCell[] = [];
  for (const [key, rows] of groups) {
    const [asset, direction] = key.split('|') as [string, 'LONG' | 'SHORT'];
    let w = 0, wr = 0, wins = 0;
    for (const s of rows) {
      const decay = Math.pow(0.5, (nowMs - s.closedAtMs) / LEARNING_HALF_LIFE_MS), weight = s.weight * decay;
      w += weight; wr += weight * s.r; if (s.r > 0) wins++;
    }
    const meanR = wr / (w + PRIOR_WEIGHT);
    const paused = w >= PAUSE_MIN_EFFECTIVE && meanR <= PAUSE_MEAN_R;
    const riskMultiplier = paused ? 0 : Math.max(MIN_MULT, Math.min(MAX_MULT, 1 + meanR));
    cells.push({ asset, direction, trades: rows.length, effectiveTrades: Number(w.toFixed(2)), winRate: rows.length ? wins / rows.length : null,
      meanR: Number(meanR.toFixed(3)), riskMultiplier: Number(riskMultiplier.toFixed(3)), paused,
      reason: paused ? `Paused: shrunk mean ${meanR.toFixed(2)}R over ${w.toFixed(1)} effective trades`
        : `${riskMultiplier >= 1 ? 'Scaling up' : 'Scaling down'}: shrunk mean ${meanR.toFixed(2)}R over ${w.toFixed(1)} effective trades` });
  }
  cells.sort((a, b) => a.asset.localeCompare(b.asset) || a.direction.localeCompare(b.direction));
  return { version: 'v6-learning-1', generatedAtMs: nowMs, sampleCount: samples.length, cells };
}

/** Unknown pairs trade at base risk; the bot explores before it has evidence. */
export function learnedRisk(book: LearningBook | null, asset: string, direction: 'LONG' | 'SHORT'): { multiplier: number; paused: boolean; reason: string } {
  const cell = book?.cells.find(c => c.asset === asset && c.direction === direction);
  if (!cell) return { multiplier: 1, paused: false, reason: 'No history yet: base risk' };
  return { multiplier: cell.riskMultiplier, paused: cell.paused, reason: cell.reason };
}

/** Pre-v6 AI history: the live Redis list when present, else the on-disk backup the daemon keeps. */
export function readLegacyTradeBackup(file = path.join(process.cwd(), 'data', 'ai_trades_backup.json')): Trade[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.trades) ? raw.trades : [];
    return rows.map((x: unknown) => typeof x === 'string' ? JSON.parse(x) : x).filter((x: unknown): x is Trade => !!x && typeof x === 'object');
  } catch { return []; }
}
