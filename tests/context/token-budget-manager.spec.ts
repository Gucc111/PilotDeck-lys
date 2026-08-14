import test from "node:test";
import assert from "node:assert/strict";

import { TokenBudgetManager } from "../../src/context/budget/TokenBudgetManager.js";

test("budget snapshot uses conservative budget tokens for ratio while preserving real tokens", () => {
  const manager = new TokenBudgetManager({ warningRatio: 0.8, blockingRatio: 0.90 });

  const snapshot = manager.snapshotFromTokens(100, 160, { budgetTokens: 140 });

  assert.equal(snapshot.tokens, 100);
  assert.equal(snapshot.budgetTokens, 140);
  assert.equal(snapshot.ratio, 0.875);
  assert.equal(snapshot.state, "warning");
});

test("default blocking ratio is 0.90", () => {
  const manager = new TokenBudgetManager();

  const snapshot = manager.snapshotFromTokens(91, 100);

  assert.equal(snapshot.state, "blocking");
  assert.equal(snapshot.blockingRatio, 0.90);
});

test("ratio between 0.80 and 0.90 is warning state with default thresholds", () => {
  const manager = new TokenBudgetManager();

  const snapshot = manager.snapshotFromTokens(85, 100);

  assert.equal(snapshot.state, "warning");
});

test("budget snapshot preserves total context and effective input budget", () => {
  const manager = new TokenBudgetManager();

  const snapshot = manager.snapshotFromTokens(10_000, 128_000, {
    reservedOutputTokens: 65_536,
  });

  assert.equal(snapshot.totalContextTokens, 128_000);
  assert.equal(snapshot.maxContextTokens, 62_464);
  assert.equal(snapshot.effectiveContextTokens, 62_464);
  assert.equal(snapshot.maxOutputTokens, 65_536);
  assert.equal(snapshot.reservedOutputTokens, 65_536);
});
