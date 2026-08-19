import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_FILES = ["dependencies", "devDependencies"];
const MATRIX_STATUSES = ["supported", "adapted", "unsupported"];

class CompatibilityError extends Error {
  constructor(code, message) {
    super(`[compatibility.${code}] ${message}`);
    this.code = code;
  }
}

function readJson(root, name) {
  try {
    return JSON.parse(readFileSync(join(root, name), "utf8"));
  } catch (error) {
    throw new CompatibilityError("file", `could not read ${name}: ${error.message}`);
  }
}

function fail(code, message) {
  throw new CompatibilityError(code, message);
}

function sha256(root, name) {
  return createHash("sha256").update(readFileSync(join(root, name))).digest("hex");
}

function assertEqual(actual, expected, description, code = "target") {
  if (actual !== expected) {
    fail(code, `${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function packageSpec(packageJson, name) {
  for (const section of PACKAGE_FILES) {
    const value = packageJson[section]?.[name];
    if (value !== undefined) return { section, value };
  }
  return undefined;
}

/**
 * Validate the complete, pinned compatibility target for this fixture.
 *
 * @param {string} root fixture directory.
 * @returns {{agentsVersion: string, computerVersion: string, lockfileSha256: string}}
 *   The verified target summary.
 */
export function checkCompatibility(root = DEFAULT_ROOT) {
  const packageJson = readJson(root, "package.json");
  const lockfile = readJson(root, "package-lock.json");
  const target = readJson(root, "compatibility.json");
  const wrangler = readJson(root, "wrangler.jsonc");
  const matrixName = target.matrix;
  const matrix = readFileSync(join(root, matrixName), "utf8");

  assertEqual(target.schemaVersion, 1, "compatibility.json schema version");
  assertEqual(lockfile.lockfileVersion, 3, "package-lock.json lockfile version");
  assertEqual(wrangler.compatibility_date, target.target.compatibilityDate, "compatibility date");
  assertEqual(
    JSON.stringify(wrangler.compatibility_flags ?? []),
    JSON.stringify(target.target.compatibilityFlags ?? []),
    "compatibility flags",
  );

  for (const [name, expected] of Object.entries(target.packages)) {
    const declared = packageSpec(packageJson, name);
    if (!declared) fail("package-missing", `${name} is not declared in package.json`);
    assertEqual(declared.value, expected.version, `${name} ${declared.section} version`, "package-version");

    const lockRoot = lockfile.packages?.[""];
    const lockSection = PACKAGE_FILES.find((section) => lockRoot?.[section]?.[name] !== undefined);
    if (!lockSection) fail("lock-package-missing", `${name} is not declared in the lockfile root`);
    assertEqual(
      lockRoot[lockSection][name],
      expected.version,
      `${name} lockfile root version`,
      "lock-version",
    );

    const entry = lockfile.packages?.[`node_modules/${name}`];
    if (!entry) fail("lock-package-missing", `${name} has no node_modules lock entry`);
    assertEqual(entry.version, expected.version, `${name} resolved version`, "lock-version");
    assertEqual(entry.integrity, expected.integrity, `${name} integrity`, "integrity");
  }

  const lockfileDigest = sha256(root, "package-lock.json");
  assertEqual(lockfileDigest, target.lockfileSha256, "package-lock.json SHA-256", "lockfile-hash");

  for (const status of MATRIX_STATUSES) {
    if (!new RegExp(`\\|\\s*${status}\\s*\\|`, "i").test(matrix)) {
      fail("matrix-status", `${matrixName} does not contain a ${status} row`);
    }
  }
  for (const [name, expected] of Object.entries(target.packages)) {
    if (!matrix.includes(`${name}@${expected.version}`)) {
      fail("matrix-version", `${matrixName} does not record ${name}@${expected.version}`);
    }
  }

  const source = readFileSync(join(root, "index.js"), "utf8");
  if (!source.includes('from "@cloudflare/agents"')) {
    fail("source", "index.js must import the pinned Agents SDK without a local shim");
  }
  if (source.includes("./vendor/") || source.includes("./patched/")) {
    fail("source", "index.js must not use an application-specific SDK patch");
  }

  return {
    agentsVersion: target.packages["@cloudflare/agents"].version,
    computerVersion: target.packages["@cloudflare/computer"].version,
    lockfileSha256: lockfileDigest,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkCompatibility(process.argv[2] ?? DEFAULT_ROOT);
    console.log(
      `compatibility target verified: @cloudflare/agents@${result.agentsVersion}, ` +
        `@cloudflare/computer@${result.computerVersion}, ` +
        `lockfile sha256 ${result.lockfileSha256}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
