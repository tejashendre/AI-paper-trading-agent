import { z } from "zod";
import { getEnv } from "./env";
import { Logger } from "./logger";

export class LLMProxy {
  // Rate-limit cooldown cache: provider name → timestamp when cooldown expires
  private static _cooldowns: Map<string, number> = new Map();
  private static readonly COOLDOWN_MS = 60_000; // 60 second cooldown after 429

  /**
   * Queries LLM providers with sequential failover (Gemini -> Groq -> OpenRouter)
   * and enforces strict Zod schema validation on the JSON output.
   * Includes per-provider rate-limit cooldown to avoid hammering dead APIs.
   */
  static async queryAndValidate<T>(
    prompt: string,
    schema: z.ZodSchema<T>,
    timeoutMs: number = 30000
  ): Promise<T> {
    const env = getEnv();
    const schemaDesc = this.getSchemaDescription(schema);
    const finalPrompt = prompt + (schemaDesc ? `\n\nCRITICAL REQUIREMENT: Your output MUST be a single, valid JSON object matching this exact schema definition:\n\`\`\`typescript\n${schemaDesc}\n\`\`\`\nDo not include any explanation, markdown blocks other than valid JSON, or other text outside the JSON object.` : "");

    const providers = [
      {
        name: "Gemini",
        key: env.GEMINI_API_KEY,
        fn: () => this.queryGemini(finalPrompt, env.GEMINI_API_KEY!, timeoutMs)
      },
      {
        name: "Groq",
        key: env.GROQ_API_KEY,
        fn: () => this.queryGroq(finalPrompt, env.GROQ_API_KEY!, timeoutMs)
      },
      {
        name: "OpenRouter",
        key: env.OPENROUTER_API_KEY,
        fn: () => this.queryOpenRouter(finalPrompt, env.OPENROUTER_API_KEY!, timeoutMs)
      }
    ];

    let lastError = new Error("No LLM providers configured or available.");

    for (const provider of providers) {
      if (!provider.key) continue;

      // Check rate-limit cooldown
      const cooldownUntil = this._cooldowns.get(provider.name) || 0;
      if (Date.now() < cooldownUntil) {
        console.log(`[LLMProxy] Skipping ${provider.name} — rate-limited cooldown (${Math.ceil((cooldownUntil - Date.now()) / 1000)}s remaining)`);
        continue;
      }

      let textOutput = "";
      try {
        textOutput = await provider.fn();
        const parsedJson = JSON.parse(textOutput);
        
        // Zod validation acts as a strict schema gate
        const validatedData = schema.parse(parsedJson);

        // Success — clear any cooldown for this provider
        this._cooldowns.delete(provider.name);
        return validatedData;
      } catch (err: any) {
        lastError = err;
        console.warn(`[LLMProxy] ${provider.name} failed:`, err.message);
        console.warn(`[LLMProxy] Raw output was:`, textOutput);
        
        // Set cooldown on rate limit errors
        if (err.message?.includes('429') || err.message?.includes('rate_limit') || err.message?.includes('Resource has been exhausted') || err.message?.includes('quota')) {
          const errMsg = err.message?.toLowerCase() || '';
          const isDailyLimit = errMsg.includes('quota') || errMsg.includes('per day');
          const isHourlyLimit = errMsg.includes('per hour') || errMsg.includes('exhausted');
          
          let cooldownDuration = this.COOLDOWN_MS;
          if (isDailyLimit) {
            cooldownDuration = 3600_000 * 12; // 12 hours for daily limits
          } else if (isHourlyLimit) {
            cooldownDuration = 3600_000; // 1 hour
          }

          this._cooldowns.set(provider.name, Date.now() + cooldownDuration);
          console.log(`[LLMProxy] ${provider.name} rate-limited — cooldown set for ${cooldownDuration / 1000}s`);
        }
      }
    }

    // If all providers fail, throw the last error (triggering statistical fallback)
    throw lastError;
  }

  private static async queryGemini(prompt: string, apiKey: string, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          response_mime_type: "application/json"
        }
      }),
      signal: controller.signal
    });

    clearTimeout(id);

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errorText}`);
    }

    const data = await res.json();
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Empty response from Gemini");
    return text.replace(/```json/g, "").replace(/```/g, "").trim();
  }

  private static async queryGroq(prompt: string, apiKey: string, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    // Using Llama 3.3 70B for strong reasoning capabilities
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        response_format: { type: "json_object" }
      }),
      signal: controller.signal
    });

    clearTimeout(id);

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errorText}`);
    }

    const data = await res.json();
    let text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty response from Groq");
    return text.replace(/```json/g, "").replace(/```/g, "").trim();
  }

  private static async queryOpenRouter(prompt: string, apiKey: string, timeoutMs: number): Promise<string> {
    const models = [
      "meta-llama/llama-3.3-70b-instruct",
      "deepseek/deepseek-chat",
      "meta-llama/llama-3.3-70b-instruct:free",
      "meta-llama/llama-3.2-3b-instruct:free"
    ];
    
    let lastError: any = null;
    
    for (const model of models) {
      try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeoutMs);

        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "HTTP-Referer": "https://ai-quant-trader.duckdns.org",
            "X-Title": "AI Paper Trading Agent"
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1,
            response_format: { type: "json_object" }
          }),
          signal: controller.signal
        });

        clearTimeout(id);

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`HTTP ${res.status}: ${errorText}`);
        }

        const data = await res.json();
        
        // Handle OpenRouter internal error blocks wrapped in 200 OK
        if (data.error) {
          throw new Error(`OpenRouter Provider Error (${model}): ${data.error.message || JSON.stringify(data.error)}`);
        }
        
        let text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error("Empty response from OpenRouter");
        return text.replace(/```json/g, "").replace(/```/g, "").trim();
      } catch (err: any) {
        lastError = err;
        console.warn(`[LLMProxy] OpenRouter model ${model} failed:`, err.message);
      }
    }
    
    throw lastError || new Error("All OpenRouter models failed.");
  }

  private static getSchemaDescription(schema: any): string {
    if (!schema || !schema._def) return "any";
    
    const typeName = schema._def.typeName;
    
    if (typeName === 'ZodEffects') {
      return this.getSchemaDescription(schema._def.schema);
    }
    if (typeName === 'ZodOptional') {
      return `${this.getSchemaDescription(schema._def.innerType)} | undefined`;
    }
    if (typeName === 'ZodNullable') {
      return `${this.getSchemaDescription(schema._def.innerType)} | null`;
    }
    if (typeName === 'ZodDefault') {
      return `${this.getSchemaDescription(schema._def.innerType)} (default: ${JSON.stringify(schema._def.defaultValue())})`;
    }
    if (typeName === 'ZodObject') {
      const shape = schema.shape;
      const lines: string[] = [];
      lines.push("{");
      for (const key in shape) {
        const field = shape[key];
        const description = field._def.description ? ` // ${field._def.description}` : "";
        const typeStr = this.getSchemaDescription(field);
        lines.push(`  "${key}": ${typeStr},${description}`);
      }
      lines.push("}");
      return lines.join("\n");
    }
    if (typeName === 'ZodEnum') {
      return schema._def.values.map((v: any) => `"${v}"`).join(" | ");
    }
    if (typeName === 'ZodString') {
      return "string";
    }
    if (typeName === 'ZodNumber') {
      return "number";
    }
    if (typeName === 'ZodBoolean') {
      return "boolean";
    }
    if (typeName === 'ZodNull') {
      return "null";
    }
    
    return "any";
  }
}
