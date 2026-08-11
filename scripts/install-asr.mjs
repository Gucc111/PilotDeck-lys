#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  chmod, mkdir, rename, rm, stat,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const funasrDir = existsSync(join(ROOT, "dist", "src", "extension", "plugins", "builtin", "funasr", "funasr-runtime.mjs"))
  ? join(ROOT, "dist", "src", "extension", "plugins", "builtin", "funasr")
  : join(ROOT, "src", "extension", "plugins", "builtin", "funasr");
const runtime = await import(pathToFileURL(join(funasrDir, "funasr-runtime.mjs")).href);
const entrypoint = join(funasrDir, "funasr-local-mcp.mjs");

const pilotHome = resolve(process.env.PILOT_HOME || join(process.env.HOME || process.env.USERPROFILE || ".", ".pilotdeck"));
const cacheRoot = join(pilotHome, "funasr");
const modelSources = [
  {
    name: "ModelScope",
    url: (repo, revision, file) => `https://www.modelscope.cn/models/${repo}/resolve/${revision}/${file}`,
  },
  {
    name: "Hugging Face",
    url: (repo, revision, file) => `https://huggingface.co/${repo}/resolve/${revision === "master" ? "main" : revision}/${file}`,
  },
];
const models = runtime.FUNASR_MODELS;

function log(message) { console.log(`[pilotdeck-asr] ${message}`); }
function fail(message) { console.error(`[pilotdeck-asr] ${message}`); }

async function isRegularFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function downloadVerified(url, destination, expectedSha256) {
  const part = `${destination}.${randomUUID()}.part`;
  await mkdir(dirname(destination), { recursive: true });
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, done) {
          hash.update(chunk);
          bytes += chunk.length;
          done(null, chunk);
        },
      }),
      createWriteStream(part, { mode: 0o600 }),
    );
    const actual = hash.digest("hex");
    if (expectedSha256 && actual !== expectedSha256) {
      throw new Error(`SHA-256 mismatch: expected ${expectedSha256}, received ${actual}`);
    }
    await rename(part, destination);
    return { bytes, sha256: actual };
  } finally {
    await rm(part, { force: true }).catch(() => undefined);
  }
}

function run(command, args) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolveResult({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}

export async function installRuntime({ platform = process.platform, arch = process.arch } = {}) {
  const asset = runtime.resolveRuntimeAsset(platform, arch);
  const target = runtime.runtimeDirectory(cacheRoot, platform, arch);
  if (runtime.findSenseVoiceBinary(cacheRoot, platform, arch)) {
    log(`Runtime ${runtime.FUNASR_RUNTIME_VERSION} (${asset.key}) is already installed.`);
    return target;
  }
  const staging = `${target}.staging-${randomUUID()}`;
  const archive = join(cacheRoot, "downloads", asset.file);
  await rm(staging, { recursive: true, force: true });
  try {
    log(`Downloading ${asset.file} from the fixed FunASR release...`);
    await downloadVerified(asset.url, archive, asset.sha256);
    await mkdir(staging, { recursive: true });
    let unpack;
    if (asset.format === "tar.gz") {
      unpack = await run("tar", ["-xzf", archive, "-C", staging]);
    } else {
      const shell = process.env.ComSpec || "powershell.exe";
      unpack = await run(shell, ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${staging.replaceAll("'", "''")}' -Force`]);
    }
    if (unpack.code !== 0) throw new Error(`unpack failed: ${unpack.stderr.trim() || unpack.stdout.trim()}`);
    const binary = runtime.findSenseVoiceBinaryIn(staging, platform);
    if (!binary) throw new Error("unpack completed but llama-funasr-sensevoice was not found");
    if (platform !== "win32") await chmod(binary, 0o755);
    await mkdir(dirname(target), { recursive: true });
    if (!existsSync(target)) await rename(staging, target);
    return target;
  } catch (error) {
    throw new Error(`Runtime stage failed (${asset.url}): ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function installModel(model) {
  const destination = join(runtime.modelDirectory(cacheRoot), model.file);
  if (await isRegularFile(destination) && (await stat(destination)).size > 0 && await fileSha256(destination) === model.sha256) {
    log(`Model ${model.file} is already installed.`);
    return destination;
  }
  await rm(destination, { force: true }).catch(() => undefined);
  const errors = [];
  for (const source of modelSources) {
    const url = source.url(model.repo, model.revision, model.file);
    try {
      log(`Downloading ${model.file} from ${source.name}...`);
      const downloaded = await downloadVerified(url, destination, model.sha256);
      log(`Downloaded ${model.file} (${downloaded.bytes} bytes, sha256=${downloaded.sha256}).`);
      return destination;
    } catch (error) {
      errors.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
      await rm(destination, { force: true }).catch(() => undefined);
    }
  }
  throw new Error(`Model download failed for ${model.file}. ${errors.join("; ")}`);
}

export function runMcpSmoke({ projectRoot = process.cwd(), runtimeRoot = cacheRoot } = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [entrypoint, "--project-root", projectRoot, "--runtime-root", runtimeRoot], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      resolveResult(value);
    };
    const timeout = setTimeout(() => finish({ code: 124, stdout, stderr }), 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes('"protocolVersion"') && stdout.includes('"transcribe_audio"')) finish({ code: 0, stdout, stderr });
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pilotdeck-asr-installer", version: "0.2.0" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  });
}

async function main() {
  log(`Installing local FunASR llama.cpp runtime into ${cacheRoot}`);
  let asset;
  try {
    asset = runtime.resolveRuntimeAsset();
    log(`Platform: ${asset.key}; CPU local runtime; no Docker or Python required.`);
    await installRuntime();
    for (const model of models) await installModel(model);
    log("Running local MCP initialize/tools/list smoke test...");
    const smoke = await runMcpSmoke();
    if (smoke.code !== 0) throw new Error(`MCP smoke failed: ${smoke.stderr.trim() || smoke.stdout.trim()}`);
    log(`FunASR is ready. Runtime and models are cached in ${cacheRoot}.`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
