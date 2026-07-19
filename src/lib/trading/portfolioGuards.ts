import { OpenPosition, Portfolio } from "@/lib/types";
import { LocalLearningRule } from "./localLearning";
import { normalizeSetupTags } from "./setupPerformance";

export type PortfolioExposureMode = "NORMAL" | "DRAWDOWN" | "RECOVERY";

export interface PortfolioGuardInput {
  portfolio: Portfolio;
  asset: string;
  direction: OpenPosition["direction"];
  dataQuality?: number;
  finalConviction?: number;
  setupTags?: string[];
  learningRules?: LocalLearningRule[];
}

export interface PortfolioGuardDecision {
  approved: boolean;
  reason: string;
  mode: PortfolioExposureMode;
  recoveryProbe: boolean;
  activeSwingCount: number;
  sameDirectionCount: number;
  weakDataCount: number;
  reduceAssetOpenCount: number;
  maxOpenPositions: number;
  maxSameDirection: number;
  maxWeakDataPositions: number;
  maxReduceAssetPositions: number;
}

function activeSwingPositions(portfolio: Portfolio): OpenPosition[] {
  return Object.values(portfolio.openPositions || {}).filter(
    (position): position is OpenPosition => Boolean(position) && position.strategyType !== "manual"
  );
}

function activeMarginUsd(portfolio: Portfolio): number {
  const swingMargin = Object.values(portfolio.openPositions || {}).reduce(
    (sum, position) => sum + (position?.usdInvested || 0),
    0
  );
  const scalpMargin = Object.values(portfolio.scalpPositions || {}).reduce(
    (sum, position) => sum + (position?.usdInvested || 0),
    0
  );
  return swingMargin + scalpMargin;
}

function estimateEquity(portfolio: Portfolio): number {
  return Math.max(portfolio.usd + activeMarginUsd(portfolio), portfolio.usd, 0);
}

function exposureMode(portfolio: Portfolio): PortfolioExposureMode {
  const equity = estimateEquity(portfolio);
  const peak = Number(portfolio.peakValue || portfolio.initialCapital || equity);
  if (!Number.isFinite(equity) || !Number.isFinite(peak) || peak <= 0) return "NORMAL";

  const drawdownPercent = ((peak - equity) / peak) * 100;
  if (drawdownPercent >= 7) return "RECOVERY";
  if (drawdownPercent >= 4.5) return "DRAWDOWN";
  return "NORMAL";
}

function maxOpenPositionsForMode(mode: PortfolioExposureMode) {
  if (mode === "RECOVERY") return 3;
  if (mode === "DRAWDOWN") return 5;
  return 7;
}

function reduceRuleKeys(rules: LocalLearningRule[] = []) {
  return new Set(
    rules
      .filter((rule) => rule.action !== "BOOST" && rule.confidenceAdjustment <= -6)
      .map((rule) => `${rule.scope}:${rule.key}`)
  );
}

function hasReduceRuleForPosition(position: OpenPosition, reduceKeys: Set<string>) {
  if (reduceKeys.has(`asset:${position.asset}`)) return true;
  return normalizeSetupTags(position.setupTags).some((tag) => reduceKeys.has(`setup:${tag}`));
}

function hasReduceRuleForCandidate(input: PortfolioGuardInput, reduceKeys: Set<string>) {
  if (reduceKeys.has(`asset:${input.asset}`)) return true;
  return normalizeSetupTags(input.setupTags).some((tag) => reduceKeys.has(`setup:${tag}`));
}

function severeReduceRules(input: PortfolioGuardInput) {
  const normalizedSetups = new Set(normalizeSetupTags(input.setupTags));
  return (input.learningRules || []).filter((rule) => {
    const matchesCandidate =
      (rule.scope === "asset" && rule.key === input.asset) ||
      (rule.scope === "setup" && normalizedSetups.has(rule.key));

    return matchesCandidate &&
      rule.action !== "BOOST" &&
      rule.confidenceAdjustment <= -8 &&
      rule.sampleSize >= 8 &&
      rule.avgMove < 0;
  });
}

function emptyDecision(input: PortfolioGuardInput, reason: string): PortfolioGuardDecision {
  const mode = exposureMode(input.portfolio);
  const positions = activeSwingPositions(input.portfolio);
  const reduceKeys = reduceRuleKeys(input.learningRules);

  return {
    approved: false,
    reason,
    mode,
    recoveryProbe: false,
    activeSwingCount: positions.length,
    sameDirectionCount: positions.filter((position) => position.direction === input.direction).length,
    weakDataCount: positions.filter((position) => Number(position.dataQuality || 0) < 80).length,
    reduceAssetOpenCount: positions.filter((position) => hasReduceRuleForPosition(position, reduceKeys)).length,
    maxOpenPositions: maxOpenPositionsForMode(mode),
    maxSameDirection: mode === "NORMAL" ? 4 : 3,
    maxWeakDataPositions: mode === "NORMAL" ? 2 : 1,
    maxReduceAssetPositions: 1,
  };
}

export class PortfolioGuards {
  static evaluateNewSwing(input: PortfolioGuardInput): PortfolioGuardDecision {
    const mode = exposureMode(input.portfolio);
    const positions = activeSwingPositions(input.portfolio);
    const reduceKeys = reduceRuleKeys(input.learningRules);
    const activeSwingCount = positions.length;
    const sameDirectionCount = positions.filter((position) => position.direction === input.direction).length;
    const weakDataCount = positions.filter((position) => Number(position.dataQuality || 0) < 80).length;
    const reduceAssetOpenCount = positions.filter((position) => hasReduceRuleForPosition(position, reduceKeys)).length;
    const maxOpenPositions = maxOpenPositionsForMode(mode);
    const maxSameDirection = mode === "NORMAL" ? 4 : 3;
    const maxWeakDataPositions = mode === "NORMAL" ? 2 : 1;
    const maxReduceAssetPositions = 1;

    const decision: PortfolioGuardDecision = {
      approved: true,
      reason: "Portfolio exposure allows this new swing attempt.",
      mode,
      recoveryProbe: false,
      activeSwingCount,
      sameDirectionCount,
      weakDataCount,
      reduceAssetOpenCount,
      maxOpenPositions,
      maxSameDirection,
      maxWeakDataPositions,
      maxReduceAssetPositions,
    };

    const quarantinedRule = severeReduceRules(input).find((rule) => rule.action === "WATCH_ONLY");
    if (quarantinedRule) {
      return emptyDecision(
        input,
        `${quarantinedRule.key} is quarantined after failing its later chronological expectancy sample; a different asset/setup must earn admission.`
      );
    }

    if (activeSwingCount >= maxOpenPositions) {
      return emptyDecision(
        input,
        `Portfolio already has ${activeSwingCount} active swing positions; ${mode.toLowerCase()} mode allows ${maxOpenPositions}.`
      );
    }

    if (sameDirectionCount >= maxSameDirection && Number(input.finalConviction || 0) < 88) {
      return emptyDecision(
        input,
        `Portfolio already has ${sameDirectionCount} ${input.direction.toLowerCase()} theses; new same-side trades need 88+ conviction.`
      );
    }

    if (Number(input.dataQuality || 0) < 80 && weakDataCount >= maxWeakDataPositions) {
      return emptyDecision(
        input,
        `Too many active trades are already running on degraded data; this entry needs cleaner live data first.`
      );
    }

    if (hasReduceRuleForCandidate(input, reduceKeys)) {
      const severeRules = severeReduceRules(input);
      const severeAssetRule = severeRules.find((rule) => rule.scope === "asset");
      const severeSetupRule = severeRules.find((rule) => rule.scope === "setup");

      if (reduceAssetOpenCount >= maxReduceAssetPositions) {
        return emptyDecision(
          input,
          `Local learning has too many reduced-confidence positions active; wait for one to close before adding another.`
        );
      }

      if (severeAssetRule && severeSetupRule) {
        return emptyDecision(
          input,
          `Closed-trade evidence is negative for both ${input.asset} and setup ${severeSetupRule.key}; wait for a different setup before risking more paper capital.`
        );
      }

      if (
        severeAssetRule &&
        (Number(input.finalConviction || 0) < 90 || Number(input.dataQuality || 0) < 85)
      ) {
        return emptyDecision(
          input,
          `${input.asset} has severe negative expectancy in the local sample; a recovery probe requires 90+ conviction and 85+ data quality.`
        );
      }

      return {
        ...decision,
        recoveryProbe: true,
        reason: severeAssetRule
          ? `${input.asset} has severe historical underperformance, so only one exceptional, small recovery probe is allowed.`
          : "Local learning is cautious on this asset/setup, so only a smaller recovery probe is allowed.",
      };
    }

    return decision;
  }
}
