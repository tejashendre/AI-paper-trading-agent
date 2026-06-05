# Final System Draft - Lean Free VPS Autonomous Trader

Date: 2026-06-05

## Production Principle

The real production system is the VPS-facing version-6/version-7 line: a lean free-mode autonomous paper trading system built to run continuously on the Oracle free VPS with zero recurring platform cost.

Everything that does not directly support this live system is noise unless it contains recoverable state, logs, or trade history.

## Final Runtime Shape

```text
Oracle Free VPS
  -> Docker Compose
    -> Redis with persistent volume
    -> Next.js dashboard/API
    -> Swing daemon
  -> mounted data backups
  -> optional Supabase free-tier memory
  -> optional free LLM providers
```

No paid services are required for the core trading loop.

## Trading Philosophy

The bot is autonomous, but autonomy must include the ability to refuse trades.

The bot should:

- Trade only when the signal has measurable edge.
- Use leverage only for high-confidence setups.
- Cap account damage before calculating upside.
- Preserve every trade and decision for learning.
- Stop trading when it has no edge.
- Stay paper-only unless live trading is explicitly unlocked in the future.

## Non-Negotiable Risk Laws

1. One trade cannot consume most of the account.
2. All entries must pass one central trade admission controller.
3. Forex, crypto, and commodities must use explicit contract/accounting rules.
4. Leverage is a tiered reward for strong setups, not a default mode.
5. Missing Redis/data state must not silently wipe history.
6. The dashboard must show what is truly running.

## Leverage Model

```text
Weak setup: HOLD
Valid but ordinary setup: 1.0x to 1.5x
Strong setup: up to 2.0x
Elite setup: up to 3.0x
Rare best setup: up to 5.0x paper-only maximum
```

Hard caps still apply:

- Max margin per autonomous trade: 10% of account equity.
- Max total active margin: 25% of account equity.
- Max loss per trade: normally 1.5% of equity or less.
- If drawdown rises, risk and leverage reduce automatically.

## Self-Learning Foundation Loop

```text
Market data
  -> indicators/statistics
  -> swing signal
  -> setup classification
  -> trade admission
  -> leverage admission
  -> paper execution
  -> portfolio update
  -> Redis/JSON/Supabase memory
  -> performance by setup
  -> future confidence score
```

The LLM is optional. The system must still operate through deterministic math and locally stored outcomes when free LLM providers are unavailable.

## Current Fix Campaign

This campaign fixes the first production blockers:

- Central asset specs.
- Central trade admission.
- Safe leverage tiers.
- Forex PnL and fee sanity.
- Swing daemon wired through shared risk logic.
- Manual/API trade paths wired through the same logic where applicable.
- Dashboard truth cleanup.
- VPS cleanup after code is verified and backed up.

