#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const base = new URL(process.env.CELLD_URL ?? "http://127.0.0.1:8080");
if (base.username || base.password) {
  throw new Error("CELLD_URL must not include credentials");
}
const requestTimeoutMs = positive("CELLD_REQUEST_TIMEOUT_MS", 10_000);
const drainTimeoutMs = positive("CELLD_SHUTDOWN_DRAIN_MS", 30_000);
const processName = process.env.CELLD_PROCESS_NAME ?? "celld";

function positive(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function endpoint(path) {
  return new URL(path, base).toString();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ready() {
  const deadline = Date.now() + positive("CELLD_READINESS_TIMEOUT_MS", 60_000);
  let lastError = "not reachable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint("/conformance/names"));
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await wait(250);
  }
  throw new Error(`celld did not become ready (${lastError})`);
}

async function processExists(pid) {
  try {
    await readFile(`/proc/${pid}/cmdline`);
    return true;
  } catch {
    return false;
  }
}

async function findCelldPid() {
  if (process.env.CELLD_PID !== undefined) {
    const pid = Number(process.env.CELLD_PID);
    if (!Number.isSafeInteger(pid) || pid < 1) {
      throw new Error("CELLD_PID must be a positive integer");
    }
    return pid;
  }
  let entries;
  try {
    entries = await readdir("/proc");
  } catch {
    throw new Error("set CELLD_PID or CELLD_SHUTDOWN_COMMAND outside Linux");
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const command = (await readFile(`/proc/${entry}/cmdline`)).toString("utf8");
      if (command.split("\0").some((part) => part.endsWith(`/${processName}`) || part === processName)) {
        return Number(entry);
      }
    } catch {
      // The process may exit between readdir and readFile.
    }
  }
  throw new Error(`could not find ${processName}; set CELLD_PID explicitly`);
}

async function waitForExit(pid, deadline) {
  while (Date.now() < deadline) {
    if (!(await processExists(pid))) return;
    await wait(100);
  }
  throw new Error(`celld did not exit within ${drainTimeoutMs}ms`);
}

async function waitForChildExit(child, deadline) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const remaining = Math.max(0, deadline - Date.now());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`celld did not exit within ${drainTimeoutMs}ms`));
    }, remaining);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startChild() {
  const command = process.env.CELLD_SHUTDOWN_COMMAND;
  if (!command) return null;
  // Use `exec` in the shell so the PID we signal is the node process rather
  // than an intermediate shell. Commands containing their own process
  // supervisor should still arrange for SIGTERM to reach celld.
  const child = spawn(`exec ${command}`, {
    shell: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-8_192);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });
  child.once("error", (error) => {
    child.spawnError = error;
  });
  child.output = () => ({ stdout, stderr });
  return child;
}

const child = await startChild();
await ready();
let settled = false;
const inFlight = fetch(endpoint("/conformance/code-mode/alpha"), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ operation: "wait" }),
  signal: AbortSignal.timeout(requestTimeoutMs),
}).then(
  (response) => {
    settled = true;
    return response;
  },
  (error) => {
    settled = true;
    throw error;
  },
);
await wait(250);
if (settled) {
  throw new Error("loaded-worker drain probe settled before shutdown");
}

const pid = child?.pid ?? await findCelldPid();
if (!pid) throw new Error("celld process has no pid");
try {
  process.kill(pid, "SIGTERM");
} catch (error) {
  throw new Error(`could not signal celld pid ${pid}: ${error.message}`);
}

const deadline = Date.now() + drainTimeoutMs;
await Promise.all([
  child ? waitForChildExit(child, deadline) : waitForExit(pid, deadline),
  inFlight.then(
    () => undefined,
    () => undefined,
  ),
]);

if (child) {
  const exit = await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (child.spawnError) throw child.spawnError;
  if (exit.code !== 0 || exit.signal !== null) {
    const output = child.output();
    throw new Error(
      `celld exited ${JSON.stringify(exit)} during shutdown drain\n` +
      `${output.stdout}${output.stderr}`,
    );
  }
}

console.log(`PASS shutdown drain (pid ${pid}, loaded work was in flight)`);
