const fs = require('fs');

const aiJson = {"usd":10246.021807091864,"btc":0,"balances":{"BTC":0,"ETH":0,"SOL":0,"EURUSD":0,"GOLD":0,"OIL":0,"SILVER":0,"USDJPY":0},"openPositions":{},"initialCapital":10000,"lastUpdated":"2026-06-05T11:42:00.000Z","totalPnl":261.0785247885849,"totalTrades":1,"winningTrades":1,"losingTrades":0,"grossProfit":261.0785247885849,"grossLoss":0,"consecutiveWins":1,"consecutiveLosses":0,"maxConsecutiveWins":1,"maxConsecutiveLosses":0,"peakValue":10405.788772904136,"maxDrawdown":0,"maxDrawdownPercent":2.743018660728825,"returns":[3.3668892319026082],"totalFeesPaid":53.978192908136286,"openPosition":null};

const userJson = {"usd":9000,"btc":0,"lastUpdated":"2026-06-05T11:42:00.000Z","balances":{"BTC":0,"ETH":0,"SOL":0,"EURUSD":0,"GOLD":0,"OIL":0,"SILVER":0,"USDJPY":0},"openPositions":{"BTC":{"asset":"BTC","entryPrice":74951.9,"amount":0.01334188993207644,"btcAmount":0.01334188993207644,"usdInvested":1000,"stopLoss":78699.495,"takeProfit":67456.70999999999,"entryTime":"2026-05-27T16:21:26.469Z","signalScore":0,"reasoning":"Manual SHORT order","direction":"SHORT"}},"totalFeesPaid":0,"peakValue":10184.172782811376,"maxDrawdownPercent":0.2691278996641543};

console.log("docker exec quant-redis redis-cli set ai:portfolio '" + JSON.stringify(aiJson) + "'");
console.log("docker exec quant-redis redis-cli set user:portfolio '" + JSON.stringify(userJson) + "'");
