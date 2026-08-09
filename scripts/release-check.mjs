// Release gate: version consistency, release assets, and a sanitization scan
// over every tracked file plus Git identities. Run via `npm run check`; CI
// runs it on every push so a release can never skip the privacy gate.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const versions = JSON.parse(readFileSync(new URL("versions.json", root), "utf8"));

const failures = [];
if (manifest.version !== pkg.version) failures.push("manifest.json and package.json versions differ");
if (versions[manifest.version] !== manifest.minAppVersion) {
  failures.push("versions.json does not map the release version to minAppVersion");
}

for (const asset of ["main.js", "manifest.json", "styles.css"]) {
  try {
    readFileSync(new URL(asset, root));
  } catch {
    failures.push(`missing release asset: ${asset}`);
  }
}

// Release documentation standard: every release ships a GUIDE.md
// (human + agent walkthrough: how it works, install, configure, workflows)
// and a README with at least one real screenshot embed.
try {
  readFileSync(new URL("GUIDE.md", root));
} catch {
  failures.push("missing GUIDE.md (release documentation standard)");
}
try {
  const readme = readFileSync(new URL("README.md", root), "utf8");
  const embeds = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  const local = embeds.filter((p) => !/^https?:/.test(p));
  if (local.length === 0) {
    failures.push("README.md has no screenshot embeds (release documentation standard)");
  }
  for (const p of local) {
    try {
      readFileSync(new URL(p, root));
    } catch {
      failures.push(`README.md embeds missing image: ${p}`);
    }
  }
} catch {
  failures.push("missing README.md");
}

let tracked = [];
let identityLog = "";
try {
  tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(Boolean);
  identityLog = execFileSync("git", ["log", "--all", "--format=%ae%n%ce"], {
    cwd: root,
    encoding: "utf8",
  });
} catch {
  // Pre-init tree: scan falls back to the known file set.
  tracked = [
    "main.js", "manifest.json", "styles.css", "versions.json", "package.json",
    "README.md", "AGENTS.md", "CHANGELOG.md", "LICENSE",
    "src/main.js", "src/shell.js",
    "scripts/release-check.mjs", "scripts/smoke-test.cjs",
    ".github/workflows/release-check.yml",
  ];
}
if (/@[^\n>]*\.local\b/i.test(identityLog)) {
  failures.push("Git history contains a machine-local author or committer identity");
}

const checks = [
  ["macOS absolute user path", new RegExp("/" + "Users/", "i")],
  ["Linux absolute home path", new RegExp("/" + "home/[a-z0-9._-]+/", "i")],
  ["private Tailscale hostname", new RegExp("[a-z0-9.-]+\\." + "ts\\.net", "i")],
  ["private vault name", new RegExp("Cobb" + "Vault2", "i")],
  ["private vault system path", new RegExp("7\\. " + "System/")],
  ["private writer script", new RegExp("dd_" + "add\\.py")],
  ["email address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["private-key block", new RegExp("BEGIN [A-Z ]*" + "PRIVATE KEY")],
  ["GitHub token", new RegExp("gh" + "[opsu]_[A-Za-z0-9]{20,}")],
  ["OpenAI-style secret", new RegExp("sk" + "-[A-Za-z0-9_-]{20,}")],
  ["Slack token", new RegExp("xox" + "[abprs]-[A-Za-z0-9-]{20,}")],
  ["Google API key", new RegExp("AI" + "za[0-9A-Za-z_-]{30,}")],
  ["Google OAuth secret", new RegExp("GOC" + "SPX-[0-9A-Za-z_-]{20,}")],
  ["Telegram bot token", new RegExp("\\b\\d{8,10}:" + "[A-Za-z0-9_-]{30,}\\b")],
  ["assigned credential", /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+-]{12,}/i],
];

const BINARY_RE = /\.(png|jpe?g|gif|webp|mp4|woff2?|ico)$/i;
for (const file of tracked) {
  if (BINARY_RE.test(file)) continue; // images scanned by provenance, not regex
  let contents;
  try {
    contents = readFileSync(new URL(file, root), "utf8");
  } catch {
    continue;
  }
  for (const [label, pattern] of checks) {
    if (pattern.test(contents)) failures.push(`${file}: ${label}`);
  }
}

// Self-test seam: prove the scanner catches a synthetic private path and a
// machine-local Git identity, without either value existing verbatim here.
if (process.argv.includes("--self-test")) {
  const plantedPath = ["/U", "sers/someone/Secret", "Vault/note.md"].join("");
  const plantedIdentity = ["someone@laptop", ".local"].join("");
  const pathHit = checks.some(([, pattern]) => pattern.test(plantedPath));
  const identityHit = /@[^\n>]*\.local\b/i.test(plantedIdentity);
  if (!pathHit || !identityHit) {
    console.error(`Self-test FAILED: private path caught=${pathHit}, local identity caught=${identityHit}`);
    process.exit(1);
  }
  console.log("Self-test passed: synthetic private path and machine-local identity both fail the gate.");
  process.exit(0);
}

if (failures.length) {
  console.error("Release check failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log(`Release check passed for Dev Board ${manifest.version} (${tracked.length} tracked files scanned).`);
