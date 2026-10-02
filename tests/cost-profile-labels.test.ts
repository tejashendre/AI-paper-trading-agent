import assert from "node:assert/strict";
import { test } from "node:test";
import { getExecutionCostProfile } from "@/lib/trading/executionCostModel";
import { CONFIGURED_ASSETS } from "@/lib/trading/instrumentRegistry";

test("every configured asset's cost profile names the Bybit venue it actually trades on", () => {
  for (const asset of CONFIGURED_ASSETS) {
    assert.match(getExecutionCostProfile(asset).venueModel, /^BYBIT_/, `${asset} still carries a pre-Bybit venue label`);
  }
});
