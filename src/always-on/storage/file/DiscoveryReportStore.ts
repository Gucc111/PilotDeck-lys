import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { reportMarkdownPath, type AlwaysOnPaths } from "./AlwaysOnPaths.js";

export class DiscoveryReportStore {
  constructor(private readonly paths: AlwaysOnPaths) {}

  async writeReport(runId: string, markdown: string): Promise<string> {
    const filePath = reportMarkdownPath(this.paths, runId);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, markdown, "utf-8");
    return filePath;
  }
}
