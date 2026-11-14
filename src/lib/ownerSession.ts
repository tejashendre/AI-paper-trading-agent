import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";

export const OWNER_COOKIE = "owner_session";
export const OWNER_SESSION_SECONDS = 8 * 60 * 60;

export function matchesOwnerSecret(candidate: string) {
  const secret = getEnv().DASHBOARD_SECRET;
  if (candidate === "SPECTATOR" || candidate.length !== secret.length) return false;
  const supplied = Buffer.from(candidate);
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sign(expires: string) {
  return createHmac("sha256", getEnv().DASHBOARD_SECRET).update("owner-session:" + expires).digest("hex");
}

export function createOwnerSession() {
  const expires = String(Date.now() + OWNER_SESSION_SECONDS * 1000);
  return expires + "." + sign(expires);
}

export function isOwnerSession(value?: string) {
  if (!value || !/^\d{13}\.[a-f0-9]{64}$/.test(value)) return false;
  const [expires, signature] = value.split(".");
  if (Number(expires) <= Date.now() || getEnv().DASHBOARD_SECRET === "SPECTATOR") return false;
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(sign(expires), "hex"));
}
