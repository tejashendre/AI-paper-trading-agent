#!/usr/bin/env npx tsx
/**
 * Trading MCP Server — Read-Only Model Context Protocol Server
 * 
 * A self-contained MCP server using stdio JSON-RPC 2.0 transport.
 * Provides read-only inspection tools for the Autonomous Paper Trading Agent.
 * 
 * NO external MCP SDK dependency. Parses stdin line-by-line for JSON-RPC
 * requests and writes JSON-RPC responses to stdout.
 * 
 * Run with: npx tsx kaggle/mcp/trading_mcp_server.ts
 * 
 * Environment Variables:
 *   STATUS_URL       - API endpoint (default: https://ai-quant-trader.duckdns.org/api/user/status)
 *   STATUS_AUTH_TOKEN - Bearer token  (default: SPECTATOR)
 */

import * as readline from 'readline';
import * as https from 'https';
import * as http from 'http';

// ─── Types ──────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface PortfolioEntry {
  asset: string;
  quantity: number;
  avgPrice: number;
  currentPrice?: number;
  unrealizedPnl?: number;
}

interface ScanResult {
  asset: string;
  action: 'HOLD' | 'ENTRY' | 'BLOCKED' | 'SKIPPED';
  decisionState?: string;
  simpleStatus?: string;
  simpleReason?: string;
  nextStep?: string;
  score?: number;
  htfScore?: number;
  triggerScore?: number;
  marketStructureScore?: number;
  dataQuality?: number;
  finalConviction?: number;
  paperSize?: number;
  liquidityState?: string;
  entryGate?: {
    primaryBlocker?: string;
    [key: string]: unknown;
  };
}

interface SwingScan {
  scanId: string;
  completedAt: string;
  summary?: string;
  results: ScanResult[];
  exitSweep?: unknown;
  opportunitySweep?: unknown;
}

interface FeedAsset {
  asset: string;
  status: string;
  score: number;
  mode?: string;
  safeForFastExecution?: boolean;
  safeForSwingExecution?: boolean;
}

interface FeedHealthMatrix {
  assets: FeedAsset[];
  summary: { good: number; degraded: number; bad: number };
}

interface LearningDigest {
  headline?: string;
  totalEvaluated?: number;
  favorableRate?: number;
  activeRules?: number;
  boostCount?: number;
  cautionCount?: number;
  bestSetup?: string;
  plainFindings?: string;
}

interface StatusResponse {
  portfolio?: PortfolioEntry[];
  aiPortfolio?: unknown;
  aiTrades?: unknown[];
  userTrades?: unknown[];
  aiTotalValue?: number;
  userTotalValue?: number;
  btcPrice?: number;
  swingScan?: SwingScan;
  opportunitySummary?: unknown;
  recentOpportunities?: unknown[];
  localLearningRules?: unknown[];
  setupPerformance?: unknown;
  feedHealthMatrix?: FeedHealthMatrix;
  learningDigest?: LearningDigest;
  logs?: unknown[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizePosition(value: unknown): PortfolioEntry | null {
  const item = asRecord(value);
  const asset = typeof item.asset === 'string' ? item.asset : typeof item.symbol === 'string' ? item.symbol : 'UNKNOWN';
  const quantity = asNumber(item.quantity) ?? asNumber(item.size) ?? asNumber(item.amount) ?? 0;
  const avgPrice = asNumber(item.avgPrice) ?? asNumber(item.entryPrice) ?? asNumber(item.entry) ?? 0;
  const currentPrice = asNumber(item.currentPrice) ?? asNumber(item.livePrice);
  const unrealizedPnl = asNumber(item.unrealizedPnl) ?? asNumber(item.pnl);

  if (!asset || Math.abs(quantity) <= 0) return null;
  return { asset, quantity, avgPrice, currentPrice, unrealizedPnl };
}

function collectPositions(source: unknown): PortfolioEntry[] {
  if (Array.isArray(source)) {
    return source.map(normalizePosition).filter((position): position is PortfolioEntry => Boolean(position));
  }

  const record = asRecord(source);
  const buckets = [
    record.positions,
    record.swingPositions,
    record.scalpPositions,
    record.activePositions,
    record.openPositions,
    record.holdings,
  ];

  return buckets
    .flatMap((items) => {
      if (Array.isArray(items)) return items;
      const keyed = asRecord(items);
      return Object.keys(keyed).length > 0 ? Object.values(keyed) : [];
    })
    .map(normalizePosition)
    .filter((position): position is PortfolioEntry => Boolean(position));
}

// ─── Configuration ──────────────────────────────────────────────────────

const STATUS_URL = process.env.STATUS_URL || 'https://ai-quant-trader.duckdns.org/api/user/status';
const STATUS_AUTH_TOKEN = process.env.STATUS_AUTH_TOKEN || 'SPECTATOR';

// ─── HTTP Fetch Helper ──────────────────────────────────────────────────

/**
 * Fetches JSON from the status API using Node's built-in http/https modules.
 * No external dependencies required.
 */
function fetchStatus(): Promise<StatusResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(STATUS_URL);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.get(
      url,
      {
        headers: {
          Authorization: `Bearer ${STATUS_AUTH_TOKEN}`,
          Accept: 'application/json',
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data) as StatusResponse);
            } catch (e) {
              reject(new Error(`Failed to parse JSON: ${(e as Error).message}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      }
    );

    req.on('error', (e) => reject(new Error(`Network error: ${e.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out after 15s'));
    });
  });
}

// ─── Tool Implementations ───────────────────────────────────────────────

/**
 * Tool 1: Get portfolio status — AI & Human portfolio values, PnL, positions, trades
 */
async function getPortfolioStatus(): Promise<Record<string, unknown>> {
  const status = await fetchStatus();
  const aiPositions = collectPositions(status.aiPortfolio);
  const aiTrades = status.aiTrades || [];
  const userTrades = status.userTrades || [];

  // Calculate realized PnL from closed trades
  let aiRealizedPnl = 0;
  for (const trade of aiTrades as Array<Record<string, unknown>>) {
    if (trade.realizedPnl && typeof trade.realizedPnl === 'number') {
      aiRealizedPnl += trade.realizedPnl;
    }
  }

  return {
    btcPrice: status.btcPrice ?? null,
    ai: {
      totalValue: status.aiTotalValue ?? null,
      realizedPnl: Math.round(aiRealizedPnl * 100) / 100,
      openPositions: aiPositions.length,
      totalTrades: aiTrades.length,
      positions: aiPositions.map((p) => ({
        asset: p.asset,
        quantity: p.quantity,
        avgPrice: p.avgPrice,
      })),
    },
    human: {
      totalValue: status.userTotalValue ?? null,
      totalTrades: userTrades.length,
    },
  };
}

/**
 * Tool 2: Get latest scan — scan ID, timestamp, per-asset summaries, blockers
 */
async function getLatestScan(): Promise<Record<string, unknown>> {
  const status = await fetchStatus();
  const scan = status.swingScan;

  if (!scan) {
    return { error: 'No scan data available', scanId: null };
  }

  const results = scan.results || [];
  const entries = results.filter((r) => r.action === 'ENTRY');
  const holds = results.filter((r) => r.action === 'HOLD');
  const blocks = results.filter((r) => r.action === 'BLOCKED');
  const skips = results.filter((r) => r.action === 'SKIPPED');

  // Collect primary blockers from blocked assets
  const blockerMap: Record<string, string[]> = {};
  for (const r of blocks) {
    const blocker = r.entryGate?.primaryBlocker || 'unknown';
    if (!blockerMap[blocker]) blockerMap[blocker] = [];
    blockerMap[blocker].push(r.asset);
  }

  return {
    scanId: scan.scanId,
    completedAt: scan.completedAt,
    summary: scan.summary ?? null,
    counts: {
      total: results.length,
      entries: entries.length,
      holds: holds.length,
      blocks: blocks.length,
      skips: skips.length,
    },
    assetSummaries: results.map((r) => ({
      asset: r.asset,
      action: r.action,
      simpleStatus: r.simpleStatus ?? null,
      conviction: r.finalConviction ?? null,
      dataQuality: r.dataQuality ?? null,
      primaryBlocker: r.entryGate?.primaryBlocker ?? null,
    })),
    mainBlockers: blockerMap,
  };
}

/**
 * Tool 3: Get data health — feed health matrix summary + problem assets
 */
async function getDataHealth(): Promise<Record<string, unknown>> {
  const status = await fetchStatus();
  const health = status.feedHealthMatrix;

  if (!health) {
    return { error: 'No feed health data available' };
  }

  const degradedAssets = (health.assets || []).filter((a) => a.status === 'degraded');
  const badAssets = (health.assets || []).filter((a) => a.status === 'bad');

  return {
    summary: health.summary,
    totalAssets: (health.assets || []).length,
    degradedAssets: degradedAssets.map((a) => ({
      asset: a.asset,
      score: a.score,
      mode: a.mode ?? null,
      safeForSwing: a.safeForSwingExecution ?? null,
    })),
    badAssets: badAssets.map((a) => ({
      asset: a.asset,
      score: a.score,
      mode: a.mode ?? null,
      safeForSwing: a.safeForSwingExecution ?? null,
    })),
    allClear: degradedAssets.length === 0 && badAssets.length === 0,
  };
}

/**
 * Tool 4: Get learning summary — watched opportunities, favorable rate, rules, setups
 */
async function getLearningSummary(): Promise<Record<string, unknown>> {
  const status = await fetchStatus();
  const digest = status.learningDigest;

  if (!digest) {
    return { error: 'No learning digest available' };
  }

  return {
    headline: digest.headline ?? null,
    totalEvaluated: digest.totalEvaluated ?? 0,
    favorableRate: digest.favorableRate ?? null,
    activeRules: digest.activeRules ?? 0,
    boostCount: digest.boostCount ?? 0,
    cautionCount: digest.cautionCount ?? 0,
    bestSetup: digest.bestSetup ?? null,
    plainFindings: digest.plainFindings ?? null,
    localLearningRulesCount: (status.localLearningRules || []).length,
  };
}

/**
 * Tool 5: Get public demo summary — judge-friendly plain-English overview
 */
async function getPublicDemoSummary(): Promise<Record<string, unknown>> {
  const status = await fetchStatus();
  const scan = status.swingScan;
  const health = status.feedHealthMatrix;
  const digest = status.learningDigest;

  // Determine if the system is actively trading
  const results = scan?.results || [];
  const entries = results.filter((r) => r.action === 'ENTRY');
  const isTrading = entries.length > 0;
  const aiPositions = collectPositions(status.aiPortfolio);

  // Determine scan freshness
  let scanAge = 'unknown';
  let scanFresh = false;
  if (scan?.completedAt) {
    const ageMs = Date.now() - new Date(scan.completedAt).getTime();
    const ageMin = Math.round(ageMs / 60000);
    if (ageMin < 60) {
      scanAge = `${ageMin} minutes ago`;
      scanFresh = true;
    } else if (ageMin < 1440) {
      scanAge = `${Math.round(ageMin / 60)} hours ago`;
      scanFresh = ageMin < 180;
    } else {
      scanAge = `${Math.round(ageMin / 1440)} days ago`;
    }
  }

  // Build plain-English summary
  const lines: string[] = [];
  lines.push('=== Autonomous Paper Trading Agent — Live System Summary ===');
  lines.push('');

  // What the system is doing
  if (isTrading) {
    lines.push(`📈 ACTIVE: The AI just entered ${entries.length} trade(s) in the latest scan.`);
  } else {
    lines.push('⏸️  WATCHING: The AI is monitoring markets but has not entered new trades in the latest scan.');
  }

  // Portfolio state
  if (status.aiTotalValue !== undefined) {
    lines.push(`💰 AI Portfolio Value: $${status.aiTotalValue.toLocaleString()}`);
  }
  if (aiPositions.length > 0) {
    lines.push(`📊 Open Positions: ${aiPositions.length} (${aiPositions.map((p) => p.asset).join(', ')})`);
  } else {
    lines.push('📊 Open Positions: None — fully in cash.');
  }

  // Scan health
  lines.push(`🔍 Last Scan: ${scanAge} (${scanFresh ? 'fresh' : 'stale'})`);
  lines.push(`   Scanned ${results.length} assets: ${entries.length} entries, ${results.filter((r) => r.action === 'HOLD').length} holds, ${results.filter((r) => r.action === 'BLOCKED').length} blocked`);

  // Data health
  if (health?.summary) {
    const s = health.summary;
    lines.push(`🩺 Data Feeds: ${s.good} good, ${s.degraded} degraded, ${s.bad} bad`);
  }

  // Learning
  if (digest?.headline) {
    lines.push(`🧠 Learning: ${digest.headline}`);
  }

  // Safety
  lines.push('');
  lines.push('🛡️  SAFETY: This is a PAPER TRADING system. No real money is at risk.');
  lines.push('   All trades are simulated. The system uses multi-gate risk checks');
  lines.push('   before any entry: data quality, market structure, HTF alignment,');
  lines.push('   liquidity, and conviction scoring.');

  lines.push('');
  lines.push(`🌐 Live Dashboard: https://ai-quant-trader.duckdns.org`);

  return {
    plainTextSummary: lines.join('\n'),
    isTrading,
    isScanFresh: scanFresh,
    scanAge,
    aiTotalValue: status.aiTotalValue ?? null,
    openPositionCount: aiPositions.length,
    assetsScanned: results.length,
    entriesThisScan: entries.length,
    safetyStatus: 'PAPER_TRADING_ONLY',
  };
}

// ─── MCP Tool Registry ──────────────────────────────────────────────────

const TOOLS: McpToolDefinition[] = [
  {
    name: 'get_portfolio_status',
    description:
      'Returns AI & Human portfolio values, realized PnL, open positions count, total trades, and current BTC price.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_latest_scan',
    description:
      'Returns the last scan ID, timestamp, per-asset action summaries (HOLD/ENTRY/BLOCKED/SKIPPED), conviction scores, and main blockers.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_data_health',
    description:
      'Returns the feed health matrix summary (good/degraded/bad counts) and lists any degraded or bad assets with their scores.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_learning_summary',
    description:
      'Returns the learning digest: watched opportunities count, favorable rate, active rules count, best/worst setup, and plain-English findings.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_public_demo_summary',
    description:
      'Returns a judge-friendly plain-English summary of what the system is doing, whether it is trading or waiting, why it is safe, and current portfolio state.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

/** Map tool names to their handler functions */
const TOOL_HANDLERS: Record<string, () => Promise<Record<string, unknown>>> = {
  get_portfolio_status: getPortfolioStatus,
  get_latest_scan: getLatestScan,
  get_data_health: getDataHealth,
  get_learning_summary: getLearningSummary,
  get_public_demo_summary: getPublicDemoSummary,
};

// ─── JSON-RPC 2.0 / MCP Protocol Handler ────────────────────────────────

/**
 * Builds a JSON-RPC success response.
 */
function rpcSuccess(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Builds a JSON-RPC error response.
 */
function rpcError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/**
 * Handles a single JSON-RPC request and returns the appropriate response.
 */
async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const { id, method, params } = req;

  switch (method) {
    // ── MCP Initialize ──────────────────────────────────────────────
    case 'initialize':
      return rpcSuccess(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'trading-paper-agent-mcp',
          version: '1.0.0',
          description:
            'Read-only MCP server for inspecting an autonomous paper trading agent. No mutations, no secrets exposed.',
        },
      });

    // ── Notifications (no response required) ────────────────────────
    case 'notifications/initialized':
      // Client acknowledgement — no response needed per spec
      return null;

    // ── List Tools ──────────────────────────────────────────────────
    case 'tools/list':
      return rpcSuccess(id, { tools: TOOLS });

    // ── Call Tool ────────────────────────────────────────────────────
    case 'tools/call': {
      const toolName = (params as Record<string, unknown>)?.name as string;
      if (!toolName || !TOOL_HANDLERS[toolName]) {
        return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      }

      try {
        const result = await TOOL_HANDLERS[toolName]();
        return rpcSuccess(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return rpcSuccess(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
          isError: true,
        });
      }
    }

    // ── Unknown Method ──────────────────────────────────────────────
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ─── Stdio Transport ────────────────────────────────────────────────────

/**
 * Main entry point. Sets up readline on stdin to receive JSON-RPC requests
 * and writes responses to stdout.
 */
function main(): void {
  // Prevent debug logs from contaminating the JSON-RPC channel
  const log = (msg: string) => process.stderr.write(`[mcp-server] ${msg}\n`);

  log('Starting Trading MCP Server (read-only)...');
  log(`Status URL: ${STATUS_URL}`);
  log(`Auth: Bearer ${STATUS_AUTH_TOKEN.slice(0, 4)}***`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: undefined, // We write to stdout manually
    terminal: false,
  });

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      const errResp = rpcError(null, -32700, 'Parse error: invalid JSON');
      process.stdout.write(JSON.stringify(errResp) + '\n');
      return;
    }

    // Notifications (no id) don't get responses
    if (parsed.id === undefined || parsed.id === null) {
      // Still handle it for side effects (e.g., notifications/initialized)
      await handleRequest({ ...parsed, id: null as unknown as number });
      return;
    }

    const response = await handleRequest(parsed);
    if (response) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  });

  rl.on('close', () => {
    log('stdin closed, shutting down.');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    log('SIGINT received, shutting down.');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('SIGTERM received, shutting down.');
    process.exit(0);
  });
}

main();
