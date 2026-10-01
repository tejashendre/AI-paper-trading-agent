import path from "path";
import { ExecutionLedger } from "../src/lib/trading/executionLedger";

// --directory verifies a fixture or copied ledger without touching the live one.
const flag = process.argv.indexOf("--directory");
const directory = flag >= 0 ? process.argv[flag + 1] : undefined;
if (flag >= 0 && !directory) {
  console.error("Usage: npm run ledger:verify -- [--directory <path>]");
  process.exit(2);
}

const verification = directory ? ExecutionLedger.verify(path.resolve(directory)) : ExecutionLedger.verify();
console.log(JSON.stringify(verification, null, 2));

if (!verification.valid) {
  process.exitCode = 1;
}
