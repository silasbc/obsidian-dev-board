#!/usr/bin/env node

// Select's canonical privacy gate for public Git repositories.
//
// The gate scans both the current tracked tree and every blob reachable from
// every Git ref. That second pass is the important guarantee: deleting a
// leaked value in a later commit does not make the old public blob safe.
// Binary assets require a SHA-256 review attestation and PNG/JPEG metadata is
// rejected. The file is self-contained so it can be copied into a public repo
// and run in local hooks, release checks, and GitHub Actions without the vault.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const MAX_BLOB_BYTES = 20 * 1024 * 1024;
const ATTESTATION_FILE = ".privacy-assets.json";
const BINARY_EXTENSION_RE = /\.(?:png|jpe?g|gif|webp|avif|heic|mp4|mov|m4a|mp3|wav|pdf|zip|woff2?|ttf|otf|ico)$/i;

const checks = [
  ["macOS absolute user path", new RegExp("/" + "Users/", "i")],
  ["Linux absolute home path", new RegExp("/" + "home/[a-z0-9._-]+/", "i")],
  ["private Tailscale hostname", new RegExp("[a-z0-9.-]+\\." + "ts\\.net", "i")],
  ["private vault name", new RegExp("Cobb" + "Vault2", "i")],
  ["private vault system path", new RegExp("7\\. " + "System/", "i")],
  ["private writer script", new RegExp("dd_" + "add\\.py", "i")],
  ["private-key block", new RegExp("BEGIN [A-Z ]*" + "PRIVATE KEY", "i")],
  ["GitHub token", new RegExp("gh" + "[opsu]_[A-Za-z0-9]{20,}")],
  ["OpenAI-style secret", new RegExp("sk" + "-[A-Za-z0-9_-]{20,}")],
  ["Slack token", new RegExp("xox" + "[abprs]-[A-Za-z0-9-]{20,}")],
  ["Google API key", new RegExp("AI" + "za[0-9A-Za-z_-]{30,}")],
  ["Google OAuth secret", new RegExp("GOC" + "SPX-[0-9A-Za-z_-]{20,}")],
  ["AWS access key", new RegExp("(?:AKIA|ASIA)" + "[0-9A-Z]{16}")],
  ["Stripe live secret", new RegExp("(?:sk|rk)_" + "live_[0-9A-Za-z]{16,}")],
  ["Telegram bot token", new RegExp("\\b\\d{8,10}:" + "[A-Za-z0-9_-]{30,}\\b")],
  ["JWT", new RegExp("\\bey" + "J[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b")],
  ["database credential URL", new RegExp("(?:postgres(?:ql)?|mongodb(?:\\+srv)?|mysql|redis):" + "//[^\\s/:]+:[^\\s@]+@", "i")],
  ["URL-embedded credential", new RegExp("https?" + "://[^\\s/:]+:[^\\s@]+@", "i")],
  ["assigned credential", /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{12,}/i],
  ["private IPv4 address", /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
  ["US Social Security number", /\b\d{3}-\d{2}-\d{4}\b/],
  ["US phone number", /\b(?:\+?1[-.\s]?)?(?:\(?[2-9]\d{2}\)?[-.\s])\d{3}[-.\s]\d{4}\b/],
];

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const GITHUB_NOREPLY_RE = /^[A-Z0-9._%+-]+@users\.noreply\.github\.com$/i;

function git(repo, args, options = {}) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: options.encoding === null ? null : "utf8",
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  });
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function isBinary(buffer, path = "") {
  return BINARY_EXTENSION_RE.test(path) || buffer.subarray(0, 8192).includes(0);
}

function scanText(text, label, findings, { allowGithubNoreply = false } = {}) {
  for (const [name, pattern] of checks) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(`${label}: ${name}`);
  }
  for (const email of text.match(EMAIL_RE) || []) {
    if (allowGithubNoreply && GITHUB_NOREPLY_RE.test(email)) continue;
    findings.push(`${label}: email address (${email})`);
  }
}

function inspectPng(buffer, label, findings) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 20 || !buffer.subarray(0, 8).equals(signature)) {
    findings.push(`${label}: invalid PNG signature`);
    return;
  }
  const allowed = new Set(["IHDR", "IDAT", "IEND"]);
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) {
      findings.push(`${label}: truncated PNG chunk`);
      return;
    }
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    if (!allowed.has(type)) findings.push(`${label}: PNG metadata/ancillary chunk ${type}`);
    offset = end;
    if (type === "IEND") break;
  }
}

function inspectJpeg(buffer, label, findings) {
  const latin = buffer.toString("latin1");
  if (latin.includes("Exif\u0000\u0000")) findings.push(`${label}: JPEG EXIF metadata`);
  if (latin.includes("http://ns.adobe.com/xap/")) findings.push(`${label}: JPEG XMP metadata`);
  if (latin.includes("ICC_PROFILE\u0000")) findings.push(`${label}: JPEG ICC profile metadata`);
}

function loadAttestations(repo, findings) {
  const path = join(repo, ATTESTATION_FILE);
  if (!existsSync(path)) {
    findings.push(`${ATTESTATION_FILE}: missing binary-asset review attestation`);
    return {};
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data.version !== 1 || !data.assets || typeof data.assets !== "object") {
      findings.push(`${ATTESTATION_FILE}: expected { version: 1, assets: { ... } }`);
      return {};
    }
    return data.assets;
  } catch (error) {
    findings.push(`${ATTESTATION_FILE}: unreadable (${error.message || error})`);
    return {};
  }
}

function inspectBinary(buffer, label, paths, attestations, findings, seenBinary) {
  const digest = sha256(buffer);
  const attested = attestations[digest];
  if (!attested) {
    findings.push(`${label}: binary SHA-256 ${digest} is not reviewed in ${ATTESTATION_FILE}`);
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(attested.reviewed || "")) || !String(attested.source || "").trim()) {
    findings.push(`${ATTESTATION_FILE}: ${digest} needs reviewed YYYY-MM-DD and a source`);
  }
  const path = paths.find((item) => item) || label;
  if (/\.png$/i.test(path)) inspectPng(buffer, label, findings);
  if (/\.jpe?g$/i.test(path)) inspectJpeg(buffer, label, findings);
  seenBinary.add(digest);
}

function repositoryObjects(repo) {
  const lines = String(git(repo, ["rev-list", "--objects", "--all"])).split("\n").filter(Boolean);
  const pathsByObject = new Map();
  for (const line of lines) {
    const split = line.indexOf(" ");
    const id = split === -1 ? line : line.slice(0, split);
    const path = split === -1 ? "" : line.slice(split + 1);
    if (!pathsByObject.has(id)) pathsByObject.set(id, []);
    if (path) pathsByObject.get(id).push(path);
  }
  return pathsByObject;
}

function scanRepository(repo) {
  repo = resolve(repo);
  git(repo, ["rev-parse", "--is-inside-work-tree"]);

  const findings = [];
  const attestations = loadAttestations(repo, findings);
  const seenBinary = new Set();
  const trackedFiles = String(git(repo, ["ls-files", "-z"])).split("\u0000").filter(Boolean);
  const untrackedFiles = String(git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\u0000")
    .filter(Boolean);
  const currentFiles = [...new Set([...trackedFiles, ...untrackedFiles])].sort();

  for (const path of currentFiles) {
    const full = join(repo, path);
    if (!existsSync(full)) continue;
    const buffer = readFileSync(full);
    if (buffer.length > MAX_BLOB_BYTES) {
      findings.push(`working tree:${path}: exceeds ${MAX_BLOB_BYTES} byte scan limit`);
    } else if (isBinary(buffer, path)) {
      inspectBinary(buffer, `working tree:${path}`, [path], attestations, findings, seenBinary);
    } else {
      scanText(buffer.toString("utf8"), `working tree:${path}`, findings);
    }
  }

  const objects = repositoryObjects(repo);
  let blobCount = 0;
  for (const [id, paths] of objects) {
    const type = String(git(repo, ["cat-file", "-t", id])).trim();
    if (type === "blob") {
      blobCount += 1;
      const size = Number(String(git(repo, ["cat-file", "-s", id])).trim());
      const label = `history:${id.slice(0, 12)}:${paths.join(",") || "<unpathed>"}`;
      if (!Number.isFinite(size) || size > MAX_BLOB_BYTES) {
        findings.push(`${label}: exceeds ${MAX_BLOB_BYTES} byte scan limit`);
        continue;
      }
      const buffer = git(repo, ["cat-file", "blob", id], { encoding: null, maxBuffer: MAX_BLOB_BYTES + 1024 });
      if (isBinary(buffer, paths[0] || "")) {
        inspectBinary(buffer, label, paths, attestations, findings, seenBinary);
      } else {
        scanText(buffer.toString("utf8"), label, findings);
      }
    } else if (type === "commit" || type === "tag") {
      const text = String(git(repo, ["cat-file", "-p", id]));
      scanText(text, `history:${type}:${id.slice(0, 12)}`, findings, { allowGithubNoreply: true });
    }
  }

  for (const digest of Object.keys(attestations)) {
    if (!seenBinary.has(digest)) findings.push(`${ATTESTATION_FILE}: stale/unreachable binary attestation ${digest}`);
  }

  return {
    repo,
    currentFileCount: currentFiles.length,
    objectCount: objects.size,
    blobCount,
    binaryCount: seenBinary.size,
    findings: [...new Set(findings)].sort(),
  };
}

function runSelfTest() {
  const fixture = mkdtempSync(join(tmpdir(), "select-privacy-gate-"));
  try {
    git(fixture, ["init", "-q"]);
    git(fixture, ["config", "user.name", "Select Privacy Gate"]);
    git(fixture, ["config", "user.email", ["select-privacy-gate", "users.noreply.github.com"].join("@")]);
    writeFileSync(join(fixture, ATTESTATION_FILE), "{\n  \"version\": 1,\n  \"assets\": {}\n}\n");
    const planted = ["/U", "sers/someone/Secret", "Vault/private.md"].join("");
    writeFileSync(join(fixture, "leak.txt"), planted + "\n");
    git(fixture, ["add", "."]);
    git(fixture, ["commit", "-q", "-m", "fixture leak"]);
    rmSync(join(fixture, "leak.txt"));
    git(fixture, ["add", "-u"]);
    git(fixture, ["commit", "-q", "-m", "delete fixture leak"]);
    const result = scanRepository(fixture);
    if (!result.findings.some((item) => item.startsWith("history:") && item.includes("macOS absolute user path"))) {
      throw new Error("history-only leak was not detected");
    }

    const chunk = (type, data) => {
      const header = Buffer.alloc(8);
      header.writeUInt32BE(data.length, 0);
      header.write(type, 4, 4, "ascii");
      return Buffer.concat([header, data, Buffer.alloc(4)]);
    };
    const metadataPng = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", Buffer.alloc(13)),
      chunk("tEXt", Buffer.from("Author=fixture")),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    const pngFindings = [];
    inspectPng(metadataPng, "self-test.png", pngFindings);
    if (!pngFindings.some((item) => item.includes("PNG metadata/ancillary chunk tEXt"))) {
      throw new Error("PNG metadata chunk was not detected");
    }

    console.log(
      "Privacy gate self-test passed: history-only private data and PNG metadata are both rejected."
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function usage() {
  console.log(`Usage: node ${basename(process.argv[1] || "privacy-gate.mjs")} [--repo <path>] [--self-test]`);
}

let repo = process.cwd();
let selfTest = false;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--repo") repo = process.argv[++i];
  else if (arg === "--self-test") selfTest = true;
  else if (arg === "-h" || arg === "--help") {
    usage();
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(2);
  }
}

try {
  if (selfTest) {
    runSelfTest();
  } else {
    const result = scanRepository(repo);
    if (result.findings.length) {
      console.error("Public-release privacy gate failed:\n" + result.findings.map((item) => `- ${item}`).join("\n"));
      process.exit(1);
    }
    console.log(
      `Public-release privacy gate passed: ${result.currentFileCount} current files, ` +
      `${result.blobCount} reachable historical blobs, ${result.binaryCount} reviewed binary asset(s).`
    );
  }
} catch (error) {
  console.error(`Public-release privacy gate error: ${error.message || error}`);
  process.exit(2);
}
