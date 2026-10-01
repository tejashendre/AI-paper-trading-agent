// Runs every tests/**/*.test.ts file with node's test runner and tsx.
// Files are listed with fs and passed explicitly, so no shell glob is needed
// and the command behaves the same on Windows and Linux.
import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return collect(full);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

const files = collect("tests").sort();
if (files.length === 0) {
  console.error("No tests/**/*.test.ts files found.");
  process.exit(1);
}

const run = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
process.exit(run.status ?? 1);
