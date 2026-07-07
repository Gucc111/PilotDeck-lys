import type { DiscoveryPlanStore } from "./DiscoveryPlanStore.js";
import type { WorkCycleStore } from "./WorkCycleStore.js";

export async function migrateLegacyPlanStatuses(input: {
  planStore: DiscoveryPlanStore;
  cycleStore: WorkCycleStore;
}): Promise<void> {
  const legacyStatuses = await input.planStore.consumeLegacyStatuses();
  if (legacyStatuses.length === 0) return;
  const assignments = await input.cycleStore.migrateLegacyPlanStatuses(legacyStatuses);
  for (const assignment of assignments) {
    await input.planStore.updatePlanFields(assignment.planId, {
      workCycleId: assignment.workCycleId,
    });
  }
}
