import { getEnv } from "./env";
import { Logger } from "./logger";

export class TelegramService {
    // Escape special characters for Telegram MarkdownV2
    static escapeMarkdown(text: string): string {
        return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
    }

    static async sendAlert(message: string): Promise<void> {
        return; // Disabled per user request to stop spam
    }

    static async sendTradeAlert(
        action: string,
        amount: number,
        price: number,
        reason: string,
        portfolioValue: number,
        signalScore?: number,
        sl?: number,
        tp?: number,
        assetKey: string = "BTC"
    ) {
        const icon = action === "BUY" ? "🟢" : action === "SELL" ? "🔴" : "⚪";
        const esc = this.escapeMarkdown;

        const message = [
            `${icon} *${esc(action)} ALERT \\- ${esc(assetKey)}*`,
            ``,
            `*Price*: ${esc(price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 5 }))}`,
            `*Amount*: ${esc(amount.toLocaleString("en-US", { maximumFractionDigits: 6 }))} ${esc(assetKey)}`,
            `*Reason*: ${esc(reason)}`,
            signalScore ? `*Signal Score*: ${esc(signalScore.toString())}/100` : "",
            sl ? `*Stop Loss*: ${esc(sl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 5 }))}` : "",
            tp ? `*Take Profit*: ${esc(tp.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 5 }))}` : "",
            ``,
            `*Portfolio PnL Value*: ${esc("$" + portfolioValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}`,
        ].filter(Boolean).join("\n");

        await this.sendAlert(message);
    }
}
