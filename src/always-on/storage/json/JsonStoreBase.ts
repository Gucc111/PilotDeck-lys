import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/**
 * Atomically write a JSON value to `filePath` via tmp+rename so readers
 * never observe a partially-written file.
 */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
    await rename(tmp, filePath);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * Read and parse a JSON file, returning `fallback` when the file is
 * missing or contains unparseable content.  The caller-supplied
 * `validate` callback narrows the parsed value to `T` — if it returns
 * `undefined` the fallback is used.
 */
export async function readJsonSafe<T>(
  filePath: string,
  fallback: () => T,
  validate: (parsed: unknown) => T | undefined,
): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback();
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    return validate(parsed) ?? fallback();
  } catch {
    return fallback();
  }
}
