import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  normalizePermissionSettings,
  permissionEntryToRule,
  permissionSettingsToRuleSet,
  readPermissionSettings,
  writePermissionSettings,
} from "../../src/permission/index.js";

test("V1 settings migrate safe patterns and retain ambiguous legacy rules", () => {
  const settings = normalizePermissionSettings({
    version: 1,
    allowedTools: [
      "Bash(git status:*)",
      "write_file:/tmp/project/*",
      "write_file:relative/*",
      "Write",
    ],
    disallowedTools: ["Bash(rm:*)", "mystery:any*"],
    skipPermissions: false,
  });

  assert.equal(settings.version, 2);
  assert.equal(settings.rules.length, 6);
  assert.deepEqual(settings.rules[0]?.selector?.conditions, [
    { subject: "bash.command", operator: "executableEquals", value: "git" },
    { subject: "bash.command", operator: "argvPrefix", value: ["git", "status"] },
  ]);
  assert.deepEqual(settings.rules[1]?.selector?.conditions, [{
    subject: "write_file.file_path",
    operator: "pathWithin",
    value: "/tmp/project",
  }]);
  assert.equal(settings.rules[2]?.pattern, "relative/*");
  assert.equal(settings.rules[2]?.selector, undefined);
  assert.equal(settings.rules[3]?.toolName, "write_file");
  assert.equal(settings.rules[3]?.selector, undefined);
  assert.equal(settings.rules[5]?.pattern, "any*");
});

test("V1 alias prefixes remain inert instead of becoming new allow rules", () => {
  const settings = normalizePermissionSettings({
    version: 1,
    allowedTools: ["Read:/tmp/project/*", "Bash:git status:*"],
    disallowedTools: [],
    skipPermissions: false,
  });

  assert.deepEqual(settings.rules.map((rule) => ({
    toolName: rule.toolName,
    pattern: rule.pattern,
    selector: rule.selector,
    legacyInert: rule.legacyInert,
  })), [
    {
      toolName: "read_file",
      pattern: "/tmp/project/*",
      selector: undefined,
      legacyInert: true,
    },
    {
      toolName: "bash",
      pattern: "git status:*",
      selector: undefined,
      legacyInert: true,
    },
  ]);
});

test("V1 deny with mid-token wildcard stays as legacy pattern instead of narrowing", () => {
  const settings = normalizePermissionSettings({
    version: 1,
    allowedTools: ["Bash(git status:*)"],
    disallowedTools: ["Bash(rm -r*)", "Bash(curl -f*)"],
    skipPermissions: false,
  });

  const allowRule = settings.rules.find((r) => r.behavior === "allow");
  assert.ok(allowRule?.selector, "allow rule should be migrated to V2 selector");

  const denyRules = settings.rules.filter((r) => r.behavior === "deny");
  assert.equal(denyRules.length, 2);
  for (const deny of denyRules) {
    assert.equal(deny.selector, undefined, `deny "${deny.pattern}" should NOT become a selector`);
    assert.ok(deny.pattern, `deny should retain its pattern`);
  }
});

test("V1 deny with clean token-boundary wildcard migrates normally", () => {
  const settings = normalizePermissionSettings({
    version: 1,
    allowedTools: [],
    disallowedTools: ["Bash(rm -rf:*)", "Bash(docker:*)"],
    skipPermissions: false,
  });

  const denyRules = settings.rules.filter((r) => r.behavior === "deny");
  assert.equal(denyRules.length, 2);
  const rmRule = denyRules.find((r) => r.toolName === "bash" && r.selector?.conditions?.some(
    (c) => c.operator === "argvPrefix" && Array.isArray(c.value) && c.value[1] === "-rf",
  ));
  assert.ok(rmRule?.selector, "deny rm -rf:* should migrate (clean boundary)");
  const dockerRule = denyRules.find((r) => r.toolName === "bash" && r.selector?.conditions?.some(
    (c) => c.operator === "executableEquals" && c.value === "docker",
  ));
  assert.ok(dockerRule?.selector, "deny docker:* should migrate (single token)");
});

test("V2 rules are authoritative when legacy arrays are also present", () => {
  const settings = normalizePermissionSettings({
    version: 2,
    rules: [{
      source: "user",
      behavior: "ask",
      toolName: "bash",
      selector: {
        version: 2,
        toolName: "bash",
        conditions: [{
          subject: "bash.command",
          operator: "executableEquals",
          value: "npm",
        }],
      },
    }],
    allowedTools: ["Bash(git:*)"],
    disallowedTools: ["Bash(rm:*)"],
    skipPermissions: true,
  });
  const ruleSet = permissionSettingsToRuleSet(settings);

  assert.equal(settings.rules.length, 1);
  assert.equal(ruleSet.ask.length, 1);
  assert.equal(ruleSet.allow.length, 0);
  assert.equal(ruleSet.deny.length, 0);
});

test("serialized structured session rules round-trip through the legacy string boundary", () => {
  const entry = JSON.stringify({
    source: "user",
    behavior: "allow",
    toolName: "bash",
    selector: {
      version: 2,
      toolName: "bash",
      conditions: [{
        subject: "bash.command",
        operator: "argvPrefix",
        value: ["test"],
      }],
    },
  });
  const rule = permissionEntryToRule(entry, "allow", "session");

  assert.equal(rule.source, "session");
  assert.equal(rule.behavior, "allow");
  assert.deepEqual(rule.selector?.conditions?.[0], {
    subject: "bash.command",
    operator: "argvPrefix",
    value: ["test"],
  });
});

test("disk writes always emit V2 and legacy partial updates replace one effect only", () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-permissions-"));
  const env = { ...process.env, PILOT_HOME: pilotHome };
  try {
    const initial = writePermissionSettings({
      rules: [{
        source: "user",
        behavior: "ask",
        toolName: "bash",
        selector: { version: 2, toolName: "bash" },
      }],
      skipPermissions: false,
    }, env);
    assert.equal(initial.version, 2);

    const updated = writePermissionSettings({
      allowedTools: ["Bash(git diff:*)"],
    }, env);
    assert.equal(updated.rules.filter((rule) => rule.behavior === "ask").length, 1);
    assert.equal(updated.rules.filter((rule) => rule.behavior === "allow").length, 1);

    const disk = JSON.parse(readFileSync(join(pilotHome, "permissions.json"), "utf8"));
    assert.equal(disk.version, 2);
    assert.ok(Array.isArray(disk.rules));
    assert.equal("allowedTools" in disk, false);
    assert.deepEqual(readPermissionSettings(env), updated);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});
