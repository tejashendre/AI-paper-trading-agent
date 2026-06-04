import { getSupabase } from "@/lib/supabase";
import { Logger } from "@/lib/logger";

export class DatabasePruner {
  /**
   * Prunes decision_features older than the specified retention days.
   * Keeps trade_ledger intact as it acts as a lightweight permanent journal.
   */
  static async pruneOldDecisions(retentionDays: number = 30): Promise<boolean> {
    try {
      const sb = getSupabase();
      
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
      const cutoffString = cutoffDate.toISOString();

      const { data, error } = await sb
        .from('decision_features')
        .delete()
        .lt('timestamp', cutoffString);

      if (error) {
        await Logger.error(`Database Pruner Failed: ${error.message}`);
        return false;
      }

      await Logger.info(`Database Pruner: Successfully deleted decision features older than ${retentionDays} days.`);
      return true;
    } catch (e) {
      console.error("[DatabasePruner] Execution failed:", e);
      return false;
    }
  }
}
