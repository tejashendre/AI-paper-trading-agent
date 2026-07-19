import { getRedis } from "@/lib/redis";

const SWING_SCAN_REQUEST_KEY = "swing:scan:request";

export interface SwingScanRequest {
  requestedAt: string;
  requestedBy: "dashboard" | "cron";
  targetAsset: string;
}

export async function requestSwingScan(request: SwingScanRequest): Promise<void> {
  const redis = getRedis();
  await redis.set(SWING_SCAN_REQUEST_KEY, request, { ex: 120 });
}

export async function consumeSwingScanRequest(): Promise<SwingScanRequest | null> {
  const redis = getRedis();
  const request = await redis.getdel<SwingScanRequest | string>(SWING_SCAN_REQUEST_KEY);
  if (!request) return null;
  if (typeof request === "string") {
    try {
      return JSON.parse(request) as SwingScanRequest;
    } catch {
      return null;
    }
  }
  return request;
}
