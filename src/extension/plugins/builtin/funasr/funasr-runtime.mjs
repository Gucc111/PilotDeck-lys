import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const FUNASR_RUNTIME_VERSION = "v0.2.0";
export const FUNASR_RELEASE_BASE =
  `https://github.com/modelscope/FunASR/releases/download/runtime-llamacpp-${FUNASR_RUNTIME_VERSION}`;
export const SENSEVOICE_MODEL = "sensevoice-small-q8.gguf";
export const FSMN_VAD_MODEL = "fsmn-vad.gguf";
// These are the immutable LFS object digests advertised by the upstream
// ModelScope repositories. The mirror download is accepted only if it matches.
export const FUNASR_MODELS = [
  {
    repo: "FunAudioLLM/SenseVoiceSmall-GGUF",
    file: SENSEVOICE_MODEL,
    revision: "master",
    sha256: "4ae45c94422de949b387e2e0fb10d7e14e4c42c69db30c3444ecc7d4b844b7c5",
  },
  {
    repo: "FunAudioLLM/fsmn-vad-GGUF",
    file: FSMN_VAD_MODEL,
    revision: "master",
    sha256: "1270f2559c495f4e7b6e739541151027d360761a3fda43fc147034f5719f5479",
  },
];

const ASSETS = {
  "darwin-arm64": {
    file: "funasr-llamacpp-macos-arm64.tar.gz",
    sha256: "416cbb289e31cb7575365d382155074e922fd061807a37b9ca0247dabd9bc6f9",
    format: "tar.gz",
  },
  "linux-arm64": {
    file: "funasr-llamacpp-linux-arm64.tar.gz",
    sha256: "c78987b2384c6aef339aea1bcd0e130070455d6394fa7ab7ca26840ead10d5da",
    format: "tar.gz",
  },
  "linux-x64": {
    file: "funasr-llamacpp-linux-x64.tar.gz",
    sha256: "15e6407143b4fb91d90bb37f2a41c64c4d48ea0fbe6404b88a9b70269c84f240",
    format: "tar.gz",
  },
  "win32-x64": {
    file: "funasr-llamacpp-windows-x64.zip",
    sha256: "297c962346d7e30d7a7c2c860dfaab3ff07d01fddf15e6fc5212ca9545441a51",
    format: "zip",
  },
};

export function resolveRuntimeAsset(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const asset = ASSETS[key];
  if (!asset) {
    throw new Error(
      `unsupported-platform: FunASR local runtime supports macOS ARM64, Linux ARM64/x64, and Windows x64; received ${platform}/${arch}`,
    );
  }
  return { key, ...asset, url: `${FUNASR_RELEASE_BASE}/${asset.file}` };
}

export function runtimeDirectory(runtimeRoot, platform = process.platform, arch = process.arch) {
  return join(runtimeRoot, "runtime", FUNASR_RUNTIME_VERSION, `${platform}-${arch}`);
}

export function modelDirectory(runtimeRoot) {
  return join(runtimeRoot, "models");
}

export function findSenseVoiceBinary(runtimeRoot, platform = process.platform, arch = process.arch) {
  const root = runtimeDirectory(runtimeRoot, platform, arch);
  return findSenseVoiceBinaryIn(root, platform);
}

export function findSenseVoiceBinaryIn(root, platform = process.platform) {
  const executable = platform === "win32" ? "llama-funasr-sensevoice.exe" : "llama-funasr-sensevoice";
  return findNamedFile(root, executable);
}

export function runtimePaths(runtimeRoot, platform = process.platform, arch = process.arch) {
  return {
    binary: findSenseVoiceBinary(runtimeRoot, platform, arch),
    model: join(modelDirectory(runtimeRoot), SENSEVOICE_MODEL),
    vad: join(modelDirectory(runtimeRoot), FSMN_VAD_MODEL),
  };
}

function findNamedFile(root, name) {
  if (!existsSync(root)) return undefined;
  const direct = join(root, name);
  if (existsSync(direct)) return direct;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isFile() && entry.name === name) return path;
      if (entry.isDirectory()) pending.push(path);
    }
  }
  return undefined;
}
