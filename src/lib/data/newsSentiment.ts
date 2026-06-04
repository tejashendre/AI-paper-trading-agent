import { getEnv } from "@/lib/env";
import { z } from "zod";
import { LLMProxy } from "@/lib/llmProxy";

export type CatalystSentiment = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'PANIC';

export interface NewsCatalystReport {
  sentiment: CatalystSentiment;
  score: number; // -100 to 100
  reasoning: string;
}

export const newsCatalystSchema = z.object({
  sentiment: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL', 'PANIC']),
  score: z.number().min(-100).max(100),
  reasoning: z.string()
});

export class NewsSentimentEngine {
  static async getMacroSentiment(): Promise<NewsCatalystReport> {
    try {
      // 1. Fetch live breaking crypto news (Free, No Auth Required)
      const res = await fetch('https://min-api.cryptocompare.com/data/v2/news/?lang=EN', {
        headers: { 'Accept': 'application/json' },
        next: { revalidate: 300 } // Cache for 5 mins
      });
      if (!res.ok) throw new Error(`CryptoCompare API failed: ${res.status}`);
      const json = await res.json();
      
      const headlines = Array.isArray(json.Data)
        ? json.Data.slice(0, 8).map((n: any) => `- ${n.title}`)
        : [];
      if (headlines.length === 0) {
        return { sentiment: 'NEUTRAL', score: 0, reasoning: 'No headlines found.' };
      }

      // 2. Feed to Gemini to parse sentiment
      const prompt = `You are a Wall Street quantitative macro analyst. 
Read the following 8 breaking crypto headlines from the last hour:

${headlines.join('\n')}

Based ONLY on these headlines, grade the overarching macro catalyst sentiment for the crypto market. 
If there is severe regulatory cracking down, exchange hacks, or major black swans, grade it PANIC. 
If it is generic news, grade it NEUTRAL.

Respond ONLY with a valid JSON object matching this exact schema:
{
  "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL" | "PANIC",
  "score": <number from -100 to 100, where -100 is apocalyptic panic, 100 is euphoric>,
  "reasoning": "One concise sentence explaining why."
}`;

      const report = await LLMProxy.queryAndValidate<NewsCatalystReport>(prompt, newsCatalystSchema as any, 10000);
      return report;
    } catch (e) {
      console.error("[NewsSentimentEngine] Error:", e);
      return { sentiment: 'NEUTRAL', score: 0, reasoning: 'Error fetching sentiment.' };
    }
  }
}
