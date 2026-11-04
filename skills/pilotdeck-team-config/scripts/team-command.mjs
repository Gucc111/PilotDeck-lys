#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";

const DEFAULT_URL = "ws://127.0.0.1:18789/ws";
const PROTOCOL_VERSION = "1.1";
const REQUEST_TIMEOUT_MS = 15_000;

function usage(message) {
  if (message) console.error(`Error: ${message}`);
  console.error(`Usage: team-command.mjs [JSON | - | --file path] [--url ws://...] [--token-file path]`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  let inputArg;
  let file;
  let url = process.env.PILOTDECK_GATEWAY_URL || DEFAULT_URL;
  let tokenFile = process.env.PILOTDECK_SERVER_TOKEN;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") file = argv[++index];
    else if (arg === "--url") url = argv[++index];
    else if (arg === "--token-file") tokenFile = argv[++index];
    else if (inputArg === undefined) inputArg = arg;
    else return usage(`Unknown argument: ${arg}`);
  }
  return { inputArg, file, url, tokenFile: tokenFile || resolve(process.env.PILOT_HOME || resolve(homedir(), ".pilotdeck"), "server-token") };
}

async function readInput({ inputArg, file }) {
  if (file) return JSON.parse(await readFile(resolve(file), "utf8"));
  if (inputArg && inputArg !== "-") return JSON.parse(inputArg);
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  if (!text.trim()) throw new Error("A team_command JSON object is required on stdin or as an argument.");
  return JSON.parse(text);
}

async function readToken(tokenFile) {
  const token = (process.env.PILOTDECK_GATEWAY_TOKEN || await readFile(resolve(tokenFile), "utf8")).trim();
  if (!token) throw new Error(`Gateway token is empty: ${tokenFile}`);
  return token;
}

function waitForOpen(ws, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolvePromise, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    const onOpen = () => { cleanup(); resolvePromise(); };
    const onError = () => { cleanup(); reject(new Error("Gateway WebSocket reported an error while opening.")); };
    const onClose = (event) => { cleanup(); reject(new Error(`Gateway WebSocket closed before opening (${event.code || "unknown"}${event.reason ? `: ${event.reason}` : ""}).`)); };
    timer = setTimeout(() => { cleanup(); reject(new Error("Gateway WebSocket open timed out.")); }, timeoutMs);
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}

function waitForMessage(ws, predicate, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolvePromise, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    const onMessage = (event) => {
      let frame;
      try { frame = JSON.parse(String(event.data ?? "")); }
      catch (error) { cleanup(); reject(new Error(`Gateway returned invalid JSON: ${error.message}`)); return; }
      if (!predicate(frame)) return;
      cleanup();
      resolvePromise(frame);
    };
    const onError = () => { cleanup(); reject(new Error("Gateway WebSocket reported an error.")); };
    const onClose = (event) => { cleanup(); reject(new Error(`Gateway WebSocket closed (${event.code || "unknown"}${event.reason ? `: ${event.reason}` : ""}).`)); };
    timer = setTimeout(() => { cleanup(); reject(new Error("Gateway request timed out.")); }, timeoutMs);
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}

async function request(url, token, method, params) {
  const ws = new WebSocket(url);
  try {
    await waitForOpen(ws);
    const helloPromise = waitForMessage(ws, (frame) => frame?.type === "hello_ok");
    ws.send(JSON.stringify({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      clientName: "cli",
      clientVersion: "1.0.0",
      token,
    }));
    await helloPromise;
    const id = randomUUID();
    const responsePromise = waitForMessage(ws, (frame) => frame?.type === "response" && frame.id === id);
    ws.send(JSON.stringify({ type: "request", id, method, params }));
    const response = await responsePromise;
    if (!response.ok) {
      const error = response.error || {};
      const failure = new Error(error.message || `Gateway rejected ${method}.`);
      failure.code = error.code;
      failure.details = error.details;
      throw failure;
    }
    return response.result;
  } finally {
    try { ws.close(); } catch { /* already closed */ }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;
  const params = await readInput(options);
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("team_command input must be a JSON object.");
  // These read-only discovery actions avoid exposing provider credentials or
  // making agents reverse engineer internal project directories.
  const discovery = { models: "model_catalog_list", projects: "list_projects" };
  const method = Object.hasOwn(discovery, params.action) ? discovery[params.action] : "team_command";
  const rpcParams = method === "team_command" ? params : {};
  if (method !== "team_command" && Object.keys(params).some(key => key !== "action")) {
    throw new Error(`${params.action} accepts only the action field.`);
  }
  const result = await request(options.url, await readToken(options.tokenFile), method, rpcParams);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  const payload = { error: { code: error.code || "TEAM_COMMAND_CLIENT_ERROR", message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } };
  console.error(JSON.stringify(payload, null, 2));
  process.exitCode = 1;
});
