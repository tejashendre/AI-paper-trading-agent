import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const roots = ["src", "scripts", "public", "package.json", "tsconfig.json", "docker-compose.yml"];

function collect(target, output) {
  if (!fs.existsSync(target)) return;
  const stats = fs.statSync(target);
  if (stats.isFile()) {
    output.push(target);
    return;
  }
  for (const entry of fs.readdirSync(target).sort()) {
    collect(path.join(target, entry), output);
  }
}

const files = [];
for (const root of roots) collect(root, files);
files.sort((a, b) => a.localeCompare(b));

const manifestHash = crypto.createHash("sha256");
let bytes = 0;
for (const file of files) {
  const content = fs.readFileSync(file);
  const normalizedPath = file.split(path.sep).join("/");
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");
  manifestHash.update(normalizedPath);
  manifestHash.update("\0");
  manifestHash.update(contentHash);
  manifestHash.update("\n");
  bytes += content.length;
}

console.log(JSON.stringify({
  hash: manifestHash.digest("hex"),
  files: files.length,
  bytes,
}));
