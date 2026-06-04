import { getRedis } from '@/lib/redis';
import { TradeJournalEntry } from '@/lib/types';
import { SupabaseDatabase } from '@/lib/supabase';

export class TradeLedger {
  private static readonly LEDGER_KEY = 'ai:trade_journal';

  /**
   * Records a completed trade into the AI's permanent memory ledger.
   */
  static async recordTrade(entry: TradeJournalEntry): Promise<void> {
    const redis = getRedis();
    await redis.lpush(this.LEDGER_KEY, JSON.stringify(entry));
    // Keep last 1000 trades in memory
    await redis.ltrim(this.LEDGER_KEY, 0, 999);

    // Persist to Supabase in the background
    SupabaseDatabase.insertTrade(entry).catch(console.error);
  }

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
