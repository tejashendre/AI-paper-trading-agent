import { createClient } from '@supabase/supabase-js';
import { getEnv } from './env';
import { Logger } from './logger';
import WebSocket from 'ws';

// Polyfill global WebSocket for Node.js 20 environment (required by Supabase JS SDK)
if (typeof global !== 'undefined' && !(global as any).WebSocket) {
    (global as any).WebSocket = WebSocket;
}

let supabaseClient: ReturnType<typeof createClient> | null = null;

export const getSupabase = () => {
    if (supabaseClient) return supabaseClient;

    const env = getEnv();
    if (!env.SUPABASE_ENABLED) {
        throw new Error("Supabase is disabled.");
    }
    if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
        throw new Error("Supabase is not configured. Missing SUPABASE_URL or SUPABASE_KEY in environment.");
    }

    supabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);
    return supabaseClient;
};

function toSnakeCase(obj: any): any {
    if (Array.isArray(obj)) {
        return obj.map(toSnakeCase);
    } else if (obj !== null && typeof obj === 'object') {
        const n: any = {};
        Object.keys(obj).forEach(k => {
            // Replace camelCase with snake_case
            const snake = k.replace(/([A-Z])/g, "_$1").toLowerCase();
            n[snake] = toSnakeCase(obj[k]);
        });
        return n;
    }
    return obj;
}

export class SupabaseDatabase {
    /**
     * Persist a closed trade to the permanent ledger.
     */
    static async insertTrade(tradeData: any): Promise<boolean> {
        try {
            const env = getEnv();
            if (!env.SUPABASE_ENABLED) return false;
            const sb = getSupabase() as any;
            const snakeData = toSnakeCase(tradeData);
            const { error } = await sb
                .from('trade_ledger')
                .insert([snakeData]);
            
            if (error) {
                console.error("[Supabase] Failed to insert trade:", error);
                return false;
            }
            return true;
        } catch (e) {
            console.warn("[Supabase] Skipping trade insert (disabled or not configured).");
            return false;
        }
    }

    /**
     * Persist a new optimized parameter reflection.
     */
    static async insertReflection(reflectionData: any): Promise<boolean> {
        try {
            const env = getEnv();
            if (!env.SUPABASE_ENABLED) return false;
            const sb = getSupabase() as any;
            const snakeData = toSnakeCase(reflectionData);
            const { error } = await sb
                .from('reflections')
                .insert([snakeData]);

            if (error) {
                console.error("[Supabase] Failed to insert reflection:", error);
                return false;
            }
            return true;
        } catch (e) {
            console.warn("[Supabase] Skipping reflection insert (disabled or not configured).");
            return false;
        }
    }

    /**
     * Persist a scanned opportunity to the decision ledger.
     */
    static async insertDecision(decisionData: any): Promise<boolean> {
        try {
            const env = getEnv();
            if (!env.SUPABASE_ENABLED) return false;
            const sb = getSupabase() as any;
            const snakeData = toSnakeCase(decisionData);
            const { error } = await sb
                .from('decision_features')
                .insert([snakeData]);

            if (error) {
                console.error("[Supabase] Failed to insert decision_features:", error);
                return false;
            }
            return true;
        } catch (e) {
            console.warn("[Supabase] Skipping decision_features insert.");
            return false;
        }
    }
}
