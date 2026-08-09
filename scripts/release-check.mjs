// Release gate: version consistency, release assets, documentation, and the
// shared history-wide privacy scanner. Run via `npm run check`; a tracked
// pre-push hook and CI both invoke the same release command.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const repoPath = fileURLToPath(root);
const privacyGate = fileURLToPath(new URL("privacy-gate.mjs", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const versions = JSON.parse(readFileSync(new URL("versions.json", root), "utf8"));

if (process.argv.includes("--self-test")) {
  execFileSync(process.execPath, [privacyGate, "--self-test"], {
    cwd: repoPath,
    stdio: "inherit",
  });
  process.exit(0);
}

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

// Every public release includes one human+agent guide and README screenshots.
try {
  readFileSync(new URL("GUIDE.md", root));
} catch {
  failures.push("missing GUIDE.md (release documentation standard)");
}
try {
  const readme = readFileSync(new URL("README.md", root), "utf8");
  const embeds = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
  const local = embeds.filter((path) => !/^https?:/.test(path));
  if (local.length === 0) failures.push("README.md has no screenshot embeds (release documentation standard)");
  for (const path of local) {
    try {
      readFileSync(new URL(path, root));
    } catch {
      failures.push(`README.md embeds missing image: ${path}`);
    }
  }
} catch {
  failures.push("missing README.md");
}

try {
  execFileSync(process.execPath, [privacyGate, "--repo", repoPath], {
    cwd: repoPath,
    stdio: "inherit",
  });
} catch {
  failures.push("history-wide privacy gate failed");
}

if (failures.length) {
  console.error("Release check failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log(`Release check passed for Dev Board ${manifest.version}.`);
