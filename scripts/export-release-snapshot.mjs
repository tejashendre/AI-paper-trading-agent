import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Redis from "ioredis";

// Read raw Redis only. Portfolio getters may repair state and are inappropriate here.
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex < 0 ? null : process.argv[outputIndex + 1];
if (!output) throw new Error("--output requires a private snapshot path");
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
redis.on("error", () => undefined);
try {
  const accounts = [];
  for (const name of ["ai", "user"]) {
    const rawPortfolio = await redis.get(`${name}:portfolio`);
    if (!rawPortfolio) throw new Error(`${name}:portfolio is missing; refusing a release snapshot`);
    const trades = (await redis.lrange(`${name}:trades`, 0, -1)).map((row) => JSON.parse(row));
    accounts.push({ name, portfolio: JSON.parse(rawPortfolio), trades });
  }
  const xsec = JSON.parse((await redis.get("xsec:portfolio")) || "null");
  const snapshot = { schemaVersion: 1, capturedAt: new Date().toISOString(), accounts, xsec };
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  fs.writeFileSync(path.resolve(output), content, { mode: 0o600 });
  console.log(JSON.stringify({
    snapshotHash: crypto.createHash("sha256").update(content).digest("hex"),
    accounts: accounts.map((account) => ({ name: account.name, trades: account.trades.length, positions: Object.keys(account.portfolio.openPositions || {}) })),
    xsecPositions: Object.keys(xsec?.positions || {}).length,
  }));
} finally {
  redis.disconnect();
}
