import { getRedis } from '@/lib/redis';
import { TradeJournalEntry } from '@/lib/types';

export class TradeLedger {
  private static readonly LEDGER_KEY = 'ai:trade_journal';

  /**
   * Retrieves recent trade history for reflection.
   */
  static async getRecentTrades(limit: number = 50): Promise<TradeJournalEntry[]> {
    const redis = getRedis();
    const raw = await redis.lrange(this.LEDGER_KEY, 0, limit - 1);
    return raw.map(str => {
      try {
        return (typeof str === 'string' ? JSON.parse(str) : str) as TradeJournalEntry;
      } catch (e) {
        return str as unknown as TradeJournalEntry;
      }
    });
  }
}
