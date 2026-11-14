import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyAuth } from "../src/lib/auth";

process.env.DASHBOARD_SECRET = "SPECTATOR";

test("the public spectator token cannot gain owner privileges even if configured as a secret", () => {
  const headers = { Authorization: "Bearer SPECTATOR" };
  assert.equal(verifyAuth(new Request("https://test.local/api/user/status", { headers })).source, "spectator");
  assert.equal(verifyAuth(new Request("https://test.local/api/trade", { method: "POST", headers })).authorized, false);
});
