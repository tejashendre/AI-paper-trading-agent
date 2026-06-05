const Redis = require('ioredis');
const redis = new Redis("redis://127.0.0.1:6379");

async function run() {
  const aiData = await redis.get('ai:portfolio');
  if (aiData) {
    const portfolio = JSON.parse(aiData);
    if (portfolio.openPositions && portfolio.openPositions['USDJPY']) {
      console.log('Restoring AI portfolio USD margin:', portfolio.openPositions['USDJPY'].usdInvested);
      portfolio.usd += portfolio.openPositions['USDJPY'].usdInvested;
      delete portfolio.openPositions['USDJPY'];
      await redis.set('ai:portfolio', JSON.stringify(portfolio));
      console.log('Cleared incorrect USDJPY position from AI portfolio locally.');
    }
  }
  
  process.exit(0);
}

run();
