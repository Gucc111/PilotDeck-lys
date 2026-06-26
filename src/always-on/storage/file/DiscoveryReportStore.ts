import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { reportMarkdownPath, type AlwaysOnPaths } from "../AlwaysOnPaths.js";

export class DiscoveryReportStore {
  constructor(private readonly paths: AlwaysOnPaths) {}

  async writeReport(runId: string, markdown: string): Promise<string> {
    const filePath = reportMarkdownPath(this.paths, runId);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, markdown, "utf-8");
    return filePath;
  }

  async readReport(runId: string): Promise<string | undefined> {
    const filePath = reportMarkdownPath(this.paths, runId);
    return safeReadFile(filePath);
  }

  async readByPath(reportFilePath: string): Promise<string | undefined> {
    const absolute = isAbsolute(reportFilePath)
      ? reportFilePath
      : resolve(this.paths.projectDir, reportFilePath);
    return safeReadFile(absolute);
  }
}

async function safeReadFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
