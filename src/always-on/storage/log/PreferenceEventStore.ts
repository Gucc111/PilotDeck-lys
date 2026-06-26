import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  PreferenceEvent,
  PreferenceEventPlan,
  PreferencePlanOutcome,
} from "../../protocol/types.js";

type LegacyPreferenceEventPlan = Omit<PreferenceEventPlan, "outcome">;

const pathQueues = new Map<string, Promise<void>>();

export class PreferenceEventStore {
  constructor(private readonly filePath: string) {}

  async appendEvent(event: PreferenceEvent): Promise<void> {
    await withPathQueue(this.filePath, async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf-8");
    });
  }

  async readAll(): Promise<PreferenceEvent[]> {
    return withPathQueue(this.filePath, () => this.readAllUnlocked());
  }

  async readUnindexedEvents(): Promise<PreferenceEvent[]> {
    const all = await this.readAll();
    return all.filter((event) => !event.indexed);
  }

  async countUnindexed(): Promise<number> {
    return (await this.readUnindexedEvents()).length;
  }

  async markIndexed(eventIds: string[]): Promise<void> {
    await withPathQueue(this.filePath, async () => {
      const all = await this.readAllUnlocked();
      const idSet = new Set(eventIds);
      let changed = false;
      for (const event of all) {
        if (idSet.has(event.eventId) && !event.indexed) {
          event.indexed = true;
          changed = true;
        }
      }
      if (!changed) return;
      const content = all.length > 0
        ? `${all.map((event) => JSON.stringify(event)).join("\n")}\n`
        : "";
      await atomicWriteFile(this.filePath, content);
    });
  }

  private async readAllUnlocked(): Promise<PreferenceEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const events: PreferenceEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const normalized = normalizePreferenceEvent(JSON.parse(line));
        if (normalized) events.push(normalized);
      } catch {
        // Ignore malformed JSONL entries without discarding valid events.
      }
    }
    return events;
  }
}

function normalizePreferenceEvent(raw: unknown): PreferenceEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const event = raw as Record<string, unknown>;
  if (
    typeof event.eventId !== "string" ||
    typeof event.timestamp !== "string" ||
    typeof event.cycleId !== "string" ||
    !Array.isArray(event.plans)
  ) {
    return undefined;
  }

  if (event.schemaVersion === 2 && (event.action === "apply" || event.action === "archive")) {
    const plans = event.plans
      .map(normalizeV2Plan)
      .filter((plan): plan is PreferenceEventPlan => !!plan);
    return {
      schemaVersion: 2,
      eventId: event.eventId,
      timestamp: event.timestamp,
      action: event.action,
      cycleId: event.cycleId,
      plans,
      indexed: event.indexed === true,
    };
  }

  if (event.schemaVersion === 1 && (event.kind === "applied" || event.kind === "archived")) {
    const outcome = event.kind;
    const plans = event.plans
      .map((plan) => normalizeLegacyPlan(plan, outcome))
      .filter((plan): plan is PreferenceEventPlan => !!plan);
    return {
      schemaVersion: 2,
      eventId: event.eventId,
      timestamp: event.timestamp,
      action: outcome === "applied" ? "apply" : "archive",
      cycleId: event.cycleId,
      plans,
      indexed: event.indexed === true,
    };
  }

  return undefined;
}

function normalizeV2Plan(raw: unknown): PreferenceEventPlan | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const plan = raw as Partial<PreferenceEventPlan>;
  if (
    typeof plan.id !== "string" ||
    typeof plan.title !== "string" ||
    (plan.outcome !== "applied" && plan.outcome !== "archived")
  ) {
    return undefined;
  }
  return {
    id: plan.id,
    title: plan.title,
    summary: typeof plan.summary === "string" ? plan.summary : "",
    dedupeKey: typeof plan.dedupeKey === "string" ? plan.dedupeKey : plan.id,
    outcome: plan.outcome,
  };
}

function normalizeLegacyPlan(
  raw: unknown,
  outcome: PreferencePlanOutcome,
): PreferenceEventPlan | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const plan = raw as Partial<LegacyPreferenceEventPlan>;
  if (typeof plan.id !== "string" || typeof plan.title !== "string") return undefined;
  return {
    id: plan.id,
    title: plan.title,
    summary: typeof plan.summary === "string" ? plan.summary : "",
    dedupeKey: typeof plan.dedupeKey === "string" ? plan.dedupeKey : plan.id,
    outcome,
  };
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, "utf-8");
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function withPathQueue<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = pathQueues.get(filePath) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  pathQueues.set(filePath, tail);
  return result.finally(() => {
    if (pathQueues.get(filePath) === tail) pathQueues.delete(filePath);
  });
}
