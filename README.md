# Autonomous Quant Trading Agent

Welcome to the **Autonomous Quant Trading Agent**. This system is an enterprise-grade, high-performance quantitative swing trading platform running entirely on a clean Next.js stack with a local Docker Redis instance, ensuring ultra-low latency and absolute reliability.

### 🌟 Key Features
- **Zero-Latency State**: Runs entirely on a local `quant-redis` Docker container.
- **Confluence Swing Trading**: The Node.js daemon evaluates 15m, 1h, and 4h timeframes for high-probability signals.
- **Glassmorphism Dashboard**: A state-of-the-art UI showing real-time portfolio value, signals, and trades.
- **Math Engine**: Custom, deterministic implementations of ATR, RSI, EMA, SMA, and MACD.

## 🚀 Quick Start

### Prerequisites
1. **Docker Desktop** (must be running to start the local Redis cache)
2. **Node.js v20+**

### Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.local.example` to `.env.local` and add your keys (ensure `REDIS_URL="redis://127.0.0.1:6379"`).

3. Start the Local Redis container:
   ```bash
   docker compose up -d redis
   ```

4. Start the Next.js Dashboard:
   ```bash
   npm run dev
   ```

5. Start the Swing Daemon (in a separate terminal):
   ```bash
   npm run daemon:swing
   ```

---

## 🏛️ Architecture

For a detailed breakdown of the system components and architecture, please refer to the [Architecture Document](AUTONOMOUS_AI_PAPER_TRADING_ARCHITECTURE.md).
