import { ExecutionLedger } from "../src/lib/trading/executionLedger";

const verification = ExecutionLedger.verify();
console.log(JSON.stringify(verification, null, 2));

if (!verification.valid) {
  process.exitCode = 1;
}
