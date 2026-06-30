#!/usr/bin/env python3
"""
Trading Reviewer Agent — Read-Only Safety & State Inspector

You are a read-only trading system reviewer. Your job is to inspect the
paper-trading agent's latest state, explain what it is doing, identify
risk warnings, and summarize whether the system is behaving safely.
You must never recommend real-money trading or execute orders.

This agent follows the ADK (Agent Development Kit) pattern:
  - Single-purpose: safety review and explainability
  - Stateless: fetches fresh state on each run
  - Composable: outputs structured data suitable for piping into other agents
  - Safe: read-only, no mutations, no secrets

Usage:
    python kaggle/agents/trading_reviewer_agent.py

Environment Variables:
    STATUS_URL         - API endpoint (default: https://ai-quant-trader.duckdns.org/api/user/status)
    STATUS_AUTH_TOKEN   - Bearer token  (default: SPECTATOR)
    GEMINI_API_KEY      - Optional. If set, sends state to Gemini for a natural-language critique.
"""

import json
import os
import re
import ssl
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# ─── Configuration ───────────────────────────────────────────────────────

STATUS_URL = os.environ.get(
    "STATUS_URL", "https://ai-quant-trader.duckdns.org/api/user/status"
)
STATUS_AUTH_TOKEN = os.environ.get("STATUS_AUTH_TOKEN", "SPECTATOR")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")

# ANSI color codes for terminal output
class Colors:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RED = "\033[91m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    MAGENTA = "\033[95m"
    CYAN = "\033[96m"
    WHITE = "\033[97m"
    BG_RED = "\033[41m"
    BG_GREEN = "\033[42m"
    BG_YELLOW = "\033[43m"


# ─── HTTP Helpers (stdlib only) ──────────────────────────────────────────

def fetch_json(url: str, token: str, timeout: int = 15) -> Dict[str, Any]:
    """Fetch JSON from a URL with Bearer auth. Uses only stdlib."""
    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "trading-reviewer-agent/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.reason}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error: {e.reason}") from e


def call_gemini(prompt: str, api_key: str, model: str = "gemini-2.0-flash") -> str:
    """Call Gemini API for natural-language review. Returns text response."""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    payload = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 1024,
        },
    }).encode("utf-8")

    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            candidates = data.get("candidates", [])
            if candidates:
                parts = candidates[0].get("content", {}).get("parts", [])
                if parts:
                    return parts[0].get("text", "No text in response.")
            return "No response from Gemini."
    except Exception as e:
        return f"Gemini API error: {e}"


# ─── Analysis Functions ──────────────────────────────────────────────────

def as_float(value: Any, default: float = 0.0) -> float:
    """Best-effort numeric parser for live API fields that may be numbers or strings."""
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return default
    return default


def normalize_position(value: Any) -> Optional[Dict[str, Any]]:
    """Normalize an API position from any supported portfolio bucket."""
    if not isinstance(value, dict):
        return None

    asset = value.get("asset") or value.get("symbol") or "UNKNOWN"
    quantity = as_float(value.get("quantity", value.get("size", value.get("amount", 0))))
    avg_price = as_float(value.get("avgPrice", value.get("entryPrice", value.get("entry", 0))))
    margin = as_float(value.get("margin", value.get("usedMargin", 0)))
    pnl = as_float(value.get("unrealizedPnl", value.get("pnl", 0)))

    if not asset or abs(quantity) <= 0:
        return None

    return {
        "asset": asset,
        "quantity": quantity,
        "avgPrice": avg_price,
        "margin": margin,
        "pnl": pnl,
        "direction": value.get("direction") or value.get("side"),
    }


def collect_positions(source: Any) -> List[Dict[str, Any]]:
    """Collect open positions from list or object-shaped live portfolio data."""
    if isinstance(source, list):
        return [p for p in (normalize_position(item) for item in source) if p]

    if not isinstance(source, dict):
        return []

    buckets = [
        source.get("positions"),
        source.get("swingPositions"),
        source.get("scalpPositions"),
        source.get("activePositions"),
        source.get("openPositions"),
        source.get("holdings"),
    ]

    positions: List[Dict[str, Any]] = []
    for bucket in buckets:
        if isinstance(bucket, list):
            items = bucket
        elif isinstance(bucket, dict):
            items = list(bucket.values())
        else:
            items = []
        positions.extend(p for p in (normalize_position(item) for item in items) if p)
    return positions


def status_equals(value: Any, expected: str) -> bool:
    return isinstance(value, str) and value.upper() == expected.upper()


def analyze_system_state(status: Dict[str, Any]) -> Dict[str, Any]:
    """Determine if the system is active based on scan recency."""
    scan = status.get("swingScan", {})
    completed_at = scan.get("completedAt")
    
    if not completed_at:
        return {"state": "UNKNOWN", "reason": "No scan data available", "scanAge": None}
    
    try:
        scan_time = datetime.fromisoformat(completed_at.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        age_minutes = (now - scan_time).total_seconds() / 60
    except (ValueError, TypeError):
        return {"state": "UNKNOWN", "reason": "Cannot parse scan timestamp", "scanAge": None}
    
    if age_minutes < 30:
        return {"state": "ACTIVE", "reason": f"Scan completed {int(age_minutes)}m ago", "scanAge": age_minutes}
    elif age_minutes < 180:
        return {"state": "ACTIVE", "reason": f"Scan completed {int(age_minutes)}m ago (within 3h window)", "scanAge": age_minutes}
    elif age_minutes < 1440:
        return {"state": "IDLE", "reason": f"Scan is {int(age_minutes / 60)}h old", "scanAge": age_minutes}
    else:
        return {"state": "INACTIVE", "reason": f"Scan is {int(age_minutes / 1440)}d old", "scanAge": age_minutes}


def analyze_scan(status: Dict[str, Any]) -> Dict[str, Any]:
    """Analyze the latest scan results."""
    scan = status.get("swingScan", {})
    results = scan.get("results", [])
    
    counts: Dict[str, int] = {"ENTRY": 0, "HOLD": 0, "BLOCKED": 0, "SKIPPED": 0}
    blockers: Dict[str, List[str]] = {}
    
    for r in results:
        action = r.get("action", "UNKNOWN")
        counts[action] = counts.get(action, 0) + 1
        
        if action == "BLOCKED":
            blocker = r.get("entryGate", {}).get("primaryBlocker", "unknown")
            if blocker not in blockers:
                blockers[blocker] = []
            blockers[blocker].append(r.get("asset", "?"))
    
    return {
        "scanId": scan.get("scanId"),
        "completedAt": scan.get("completedAt"),
        "totalAssets": len(results),
        "counts": counts,
        "blockers": blockers,
    }


def analyze_portfolio(status: Dict[str, Any]) -> Dict[str, Any]:
    """Analyze portfolio health and drawdown."""
    ai_value = status.get("aiTotalValue")
    initial_capital = 10000  # Standard paper trading starting capital
    
    ai_portfolio = status.get("aiPortfolio", {})
    open_positions = collect_positions(ai_portfolio)
    
    # Drawdown check
    drawdown: Optional[float] = None
    drawdown_warning = False
    if ai_value is not None:
        drawdown = ((ai_value - initial_capital) / initial_capital) * 100
        drawdown_warning = drawdown < -10  # More than 10% loss
    
    # Position sizing validation
    position_warnings: List[str] = []
    if ai_value and open_positions:
        for pos in open_positions:
            qty = as_float(pos.get("quantity"))
            price = as_float(pos.get("avgPrice"))
            pos_value = qty * price
            if ai_value > 0:
                concentration = (pos_value / ai_value) * 100
                if concentration > 50:
                    position_warnings.append(
                        f"{pos.get('asset', '?')}: {concentration:.1f}% of portfolio (high concentration)"
                    )
    
    return {
        "aiTotalValue": ai_value,
        "initialCapital": initial_capital,
        "drawdownPct": round(drawdown, 2) if drawdown is not None else None,
        "drawdownWarning": drawdown_warning,
        "openPositions": len(open_positions),
        "positions": [
            {
                "asset": p.get("asset"),
                "quantity": p.get("quantity"),
                "avgPrice": p.get("avgPrice"),
            }
            for p in open_positions
        ],
        "positionWarnings": position_warnings,
    }


def analyze_risk(status: Dict[str, Any], sys_state: Dict, portfolio: Dict, scan: Dict) -> List[str]:
    """Identify risk warnings across all dimensions."""
    warnings: List[str] = []
    
    # Feed health warnings
    health = status.get("feedHealthMatrix", {})
    summary = health.get("summary", {})
    bad_feeds = summary.get("bad", 0)
    degraded_feeds = summary.get("degraded", 0)
    
    if bad_feeds > 0:
        bad_assets = [a.get("asset", "?") for a in health.get("assets", []) if status_equals(a.get("status"), "BAD")]
        warnings.append(f"[RED] {bad_feeds} data feed(s) in BAD state: {', '.join(bad_assets)}")
    if degraded_feeds > 3:
        warnings.append(f"[YELLOW] {degraded_feeds} data feed(s) degraded - may affect decision quality")
    
    # Drawdown warning
    if portfolio.get("drawdownWarning"):
        warnings.append(f"[RED] Portfolio drawdown: {portfolio['drawdownPct']}% (below -10% threshold)")
    
    # Stale scan warning
    if sys_state.get("state") == "INACTIVE":
        warnings.append(f"[RED] Scan is stale - {sys_state['reason']}")
    elif sys_state.get("state") == "IDLE":
        warnings.append(f"[YELLOW] Scan is aging - {sys_state['reason']}")
    
    # Position concentration
    for pw in portfolio.get("positionWarnings", []):
        warnings.append(f"[YELLOW] {pw}")
    
    # No scan data at all
    if scan.get("totalAssets", 0) == 0:
        warnings.append("[YELLOW] No assets in latest scan results")
    
    return warnings


# ─── Report Generation ───────────────────────────────────────────────────

def print_divider(char: str = "-", width: int = 60) -> None:
    print(f"{Colors.DIM}{char * width}{Colors.RESET}")


def print_header(title: str) -> None:
    print(f"\n{Colors.BOLD}{Colors.CYAN}{'=' * 60}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.CYAN}  {title}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.CYAN}{'=' * 60}{Colors.RESET}")


def print_section(title: str) -> None:
    print(f"\n{Colors.BOLD}{Colors.BLUE}> {title}{Colors.RESET}")
    print_divider()


def generate_report(
    sys_state: Dict[str, Any],
    scan: Dict[str, Any],
    portfolio: Dict[str, Any],
    warnings: List[str],
    status: Dict[str, Any],
) -> str:
    """Generate the full safety report to stdout and return as string."""
    lines: List[str] = []
    
    def out(line: str = "") -> None:
        print(line)
        # Strip ANSI codes for the plain-text version
        clean = re.sub(r"\033\[[0-9;]*m", "", line)
        lines.append(clean)
    
    print_header("Trading System Safety Review")
    out(f"  Report Time: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    out(f"  Source: {STATUS_URL}")
    
    # ── Section 1: System State ──
    print_section("1. System State")
    state = sys_state["state"]
    state_color = {
        "ACTIVE": Colors.GREEN,
        "IDLE": Colors.YELLOW,
        "INACTIVE": Colors.RED,
        "UNKNOWN": Colors.DIM,
    }.get(state, Colors.WHITE)
    out(f"  Status: {state_color}{state}{Colors.RESET}")
    out(f"  Detail: {sys_state['reason']}")
    
    # ── Section 2: Latest Scan ──
    print_section("2. Latest Scan Summary")
    if scan.get("scanId"):
        counts = scan.get("counts", {})
        out(f"  Scan ID:    {scan['scanId']}")
        out(f"  Completed:  {scan.get('completedAt', 'N/A')}")
        out(f"  Assets:     {scan.get('totalAssets', 0)}")
        out(f"  Entries:    {Colors.GREEN}{counts.get('ENTRY', 0)}{Colors.RESET}")
        out(f"  Holds:      {Colors.YELLOW}{counts.get('HOLD', 0)}{Colors.RESET}")
        out(f"  Blocked:    {Colors.RED}{counts.get('BLOCKED', 0)}{Colors.RESET}")
        out(f"  Skipped:    {Colors.DIM}{counts.get('SKIPPED', 0)}{Colors.RESET}")
        
        if scan.get("blockers"):
            out("  Main Blockers:")
            for blocker, assets in scan["blockers"].items():
                out(f"    - {blocker}: {', '.join(assets)}")
    else:
        out(f"  {Colors.DIM}No scan data available{Colors.RESET}")
    
    # ── Section 3: Portfolio Health ──
    print_section("3. Portfolio Health")
    if portfolio.get("aiTotalValue") is not None:
        val = portfolio["aiTotalValue"]
        initial = portfolio["initialCapital"]
        dd = portfolio.get("drawdownPct")
        
        dd_color = Colors.GREEN if (dd is not None and dd >= 0) else Colors.RED
        out(f"  AI Portfolio Value:  ${val:,.2f}")
        out(f"  Initial Capital:    ${initial:,.2f}")
        if dd is not None:
            out(f"  PnL:                {dd_color}{dd:+.2f}%{Colors.RESET}")
        else:
            out("  PnL:                N/A")
    else:
        out(f"  {Colors.DIM}Portfolio data unavailable{Colors.RESET}")
    
    # ── Section 4: Active Positions ──
    print_section("4. Active Positions")
    positions = portfolio.get("positions", [])
    if positions:
        out(f"  Open: {len(positions)}")
        for p in positions:
            avg_price = p.get('avgPrice', 0)
            out(f"    - {p['asset']}: qty={p['quantity']}, avgPrice=${avg_price:,.2f}")
    else:
        out(f"  {Colors.DIM}No open positions - fully in cash{Colors.RESET}")
    
    # ── Section 5: Risk Warnings ──
    print_section("5. Risk Warnings")
    if warnings:
        for w in warnings:
            out(f"  {w}")
    else:
        out(f"  {Colors.GREEN}OK: No risk warnings detected{Colors.RESET}")
    
    # ── Section 6: Safety Verdict ──
    print_section("6. Safety Verdict")
    out(f"  {Colors.BG_GREEN}{Colors.WHITE} PAPER TRADING ONLY {Colors.RESET}")
    out("  This system operates exclusively in paper-trading mode.")
    out("  - No real funds are at risk")
    out("  - All orders are simulated")
    out("  - No exchange API keys are used for execution")
    out("  - The SPECTATOR token provides read-only access")
    
    print(f"\n{Colors.DIM}{'-' * 60}{Colors.RESET}")
    
    return "\n".join(lines)


# ─── Gemini Integration ─────────────────────────────────────────────────

def gemini_critique(report_text: str, status: Dict[str, Any]) -> None:
    """Send the state to Gemini for a natural-language review critique."""
    if not GEMINI_API_KEY:
        return
    
    print_section("7. Gemini AI Critique")
    print(f"  {Colors.DIM}Requesting Gemini review...{Colors.RESET}")
    
    prompt = f"""You are a trading system safety reviewer. Below is the current state of an
autonomous paper trading agent. Please provide a brief (3-5 sentence) critique:
- Is the system behaving safely?
- Are there any concerning patterns?
- What would you recommend monitoring?

IMPORTANT: This is a PAPER TRADING system. No real money is involved.

System State:
{report_text}

Raw metrics:
- AI Portfolio Value: ${status.get('aiTotalValue', 'N/A')}
- BTC Price: ${status.get('btcPrice', 'N/A')}
- Feed Health: {json.dumps(status.get('feedHealthMatrix', {}).get('summary', {}))}
- Learning Digest Headline: {status.get('learningDigest', {}).get('headline', 'N/A')}

Provide your critique:"""
    
    response = call_gemini(prompt, GEMINI_API_KEY, GEMINI_MODEL)
    print(f"\n  {Colors.MAGENTA}{response}{Colors.RESET}")
    print_divider()


# ─── Main ────────────────────────────────────────────────────────────────

def main() -> int:
    """Main entry point. Fetches status and generates safety report."""
    print(f"\n{Colors.DIM}Fetching status from {STATUS_URL}...{Colors.RESET}")
    
    try:
        status = fetch_json(STATUS_URL, STATUS_AUTH_TOKEN)
    except RuntimeError as e:
        print(f"\n{Colors.RED}ERROR: Failed to fetch status: {e}{Colors.RESET}")
        print(f"{Colors.DIM}Check that the dashboard is running and accessible.{Colors.RESET}")
        return 1
    except Exception as e:
        print(f"\n{Colors.RED}ERROR: Unexpected error: {e}{Colors.RESET}")
        return 1
    
    # Run analysis
    sys_state = analyze_system_state(status)
    scan = analyze_scan(status)
    portfolio = analyze_portfolio(status)
    warnings = analyze_risk(status, sys_state, portfolio, scan)
    
    # Generate report
    report_text = generate_report(sys_state, scan, portfolio, warnings, status)
    
    # Optional Gemini critique
    if GEMINI_API_KEY:
        gemini_critique(report_text, status)
    else:
        print(f"\n  {Colors.DIM}Tip: Set GEMINI_API_KEY to enable AI-powered review critique.{Colors.RESET}")
    
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
