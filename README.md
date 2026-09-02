# Autonomous Paper Trading Agent

> **Autonomous multi-asset paper trading and risk management execution system.**

An explainable, autonomous paper-trading system for observing markets, evaluating multi-timeframe setups, simulating execution, managing exits, and learning from outcomes. It is designed as a free-tier research and demonstration project, not as a real-money trading service.

**Demo video:** _coming shortly_ | **Repository:** you are here | **Author:** [Tejas Hendre](https://www.tejashendre.com/)

---

## 1. The Business Problem (Why I built this)

Risk management and algorithmic execution require ruthless discipline and precise systems. To demonstrate competence in building autonomous systems that handle live data streams, strict state-machine controls, and deterministic risk logic, I engineered a fully simulated paper trading platform. 

The system continuously watches nine assets across Crypto, Forex, and Commodities. It computes deterministic market signals, proposes entries only after data and risk checks, simulates fills and fees, monitors open positions, and records the reasoning and outcome of each decision.

---

## 2. System Architecture & Flow

The core decision path does **not** depend on an LLM. Optional language-model features can explain or summarize decisions, but deterministic indicators, admission checks, simulated execution, and exits remain resilient.

`mermaid
graph TD
    A[Market Data Providers] -->|Kraken/Yahoo APIs| B(Data Ingestion Service)
    B -->|Normalizes OHLCV| C[(Redis State Store)]
    C -->|Feed| D{Signal Generator}
    
    D -->|Deterministic Indicators| E[Admission Check]
    E -->|Approved Setup| F[Execution Engine]
    F -->|Simulated Fills & Fees| C
    
    C -->|Watchdog| G[Exit Manager]
    G -->|Trailing Stops / Take Profit| H[Close Position]
    H --> C
    
    C -->|Telemetry| I[Telegram Notifications]
    C -->|Real-time state| J[Next.js Dashboard]
    
    style D fill:#f9f,stroke:#333,stroke-width:2px
    style F fill:#bbf,stroke:#333,stroke-width:2px
`

---

## 3. Core Principles & Execution (How I do my work)

This is an autonomous **swing-trading simulator**, not an HFT engine. It is built on strict operational constraints:

- **Strict State Management:** No open positions are lost if the server restarts. State is managed deterministically through Redis.
- **Fail-safe Design:** Entry scans run approximately every 60 seconds. The exit watchdog checks open positions approximately every 5 seconds. If data is stale, the engine refuses to trade.
- **Explainability:** Every trade records the reasoning and outcome of each decision. It is an explainable system, not a black box.

---

## 4. Tech Stack

- **Framework:** Next.js 14, TypeScript
- **Database/Cache:** Redis
- **Data Integrations:** Kraken API, Yahoo Finance API
- **UI:** Lightweight-Charts
- **Alerts:** Telegram API

---

## 5. Usage / Installation

**1. Clone the repository**
`ash
git clone https://github.com/tejashendre/AI-paper-trading-agent.git
cd "Building an Autonomous Paper Trading Agent with Next"
`

**2. Install Dependencies**
`ash
npm install
`

**3. Configure Environment**
Copy .env.local.example to .env.local and add your API keys/Redis URL.

**4. Run Development Server**
`ash
npm run dev
`
Open **[http://localhost:3000](http://localhost:3000)** to view the live spectator dashboard.
