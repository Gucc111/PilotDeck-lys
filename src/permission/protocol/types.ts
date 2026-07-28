export type PermissionMode = "default" | "plan" | "bypassPermissions";

export type PermissionRuleBehavior = "allow" | "deny" | "ask";

export type PermissionRuleSource = "user" | "project" | "session" | "policy" | "cli";

export type BashCommandSubject = "bash.command";
export type PathSubject =
  | "read_file.file_path"
  | "read_file.target_path"
  | "send_attachment.file_path"
  | "send_attachment.target_path"
  | "write_file.file_path"
  | "write_file.target_path"
  | "edit_file.file_path"
  | "edit_file.target_path"
  | "edit_notebook.notebook_path"
  | "edit_notebook.target_path"
  | "glob.search_root"
  | "grep.path"
  | "grep.search_root";
export type ToolCallSubject = BashCommandSubject | PathSubject;

export type CommandOperator = "executableEquals" | "argvPrefix";
export type PathOperator = "pathEquals" | "pathWithin";
export type ToolCallOperator = CommandOperator | PathOperator;

export type ToolCallCondition =
  | {
      subject: BashCommandSubject;
      operator: "executableEquals";
      value: string;
    }
  | {
      subject: BashCommandSubject;
      operator: "argvPrefix";
      value: string[];
    }
  | {
      subject: PathSubject;
      operator: PathOperator;
      value: string;
    };

export type ToolCallSelector = {
  version: 2;
  toolName: string;
  /** Conditions are combined with AND for one semantic parameter value. */
  conditions?: readonly ToolCallCondition[];
};

export type ToolParameterDescriptor = {
  toolName: string;
  subject: ToolCallSubject;
  kind: "command" | "path";
  operators: readonly ToolCallOperator[];
};

export type ToolCallConditionMatchResult = {
  condition: ToolCallCondition;
  matched: boolean;
  reason: string;
};

export type ToolCallSelectorMatchResult = {
  matched: boolean;
  selector: ToolCallSelector;
  conditionResults: ToolCallConditionMatchResult[];
  reason:
    | "matched"
    | "tool_mismatch"
    | "unsupported_tool"
    | "unsupported_condition"
    | "invalid_input"
    | "condition_mismatch";
};

/** Short alias for consumers that do not need to distinguish selector versions. */
export type ToolCallMatchResult = ToolCallSelectorMatchResult;

export type PermissionRule = {
  source: PermissionRuleSource;
  behavior: PermissionRuleBehavior;
  toolName: string;
  pattern?: string;
  /** V2 structured selector. When present it takes precedence over pattern. */
  selector?: ToolCallSelector;
  /** Legacy entry retained for visibility but intentionally never matched. */
  legacyInert?: boolean;
};

export type PermissionRuleSet = {
  allow: PermissionRule[];
  deny: PermissionRule[];
  ask: PermissionRule[];
};

export type PermissionContext = {
  mode: PermissionMode;
  rules: PermissionRuleSet;
  cwd: string;
  additionalWorkingDirectories: string[];
  canPrompt: boolean;
  bypassAvailable: boolean;
  /** Absolute path of the project-local `.pilotdeck/plans` directory. */
  planDirectoryPath?: string;
};

export type PermissionDecisionReason =
  | { type: "mode"; mode: PermissionMode; message: string }
  | { type: "rule"; behavior: PermissionRuleBehavior; rule: PermissionRule; message: string }
  | { type: "tool"; toolName: string; message: string }
  | { type: "safety"; message: string }
  | { type: "runtime"; message: string };

export type PermissionRequest = {
  toolCallId: string;
  toolName: string;
  inputSummary: string;
  reason: PermissionDecisionReason;
  options: PermissionRequestOption[];
  metadata?: Record<string, unknown>;
};

export type PermissionRequestOption =
  | { id: "allow_once"; label: string }
  | { id: "allow_session"; label: string; rules?: PermissionRule[] }
  | { id: "deny"; label: string }
  | { id: "cancel"; label: string };

export type PermissionDecision =
  | {
      type: "allow";
      reason: PermissionDecisionReason;
      updatedInput?: unknown;
    }
  | {
      type: "deny";
      reason: PermissionDecisionReason;
      message: string;
    }
  | {
      type: "ask";
      reason: PermissionDecisionReason;
      request: PermissionRequest;
    }
  | {
      type: "cancel";
      reason: PermissionDecisionReason;
      message: string;
    };

export type PermissionResult = PermissionDecision | { type: "passthrough"; reason?: PermissionDecisionReason };

export function emptyPermissionRuleSet(): PermissionRuleSet {
  return {
    allow: [],
    deny: [],
    ask: [],
  };
}

export function createDefaultPermissionContext(options: {
  cwd: string;
  mode?: PermissionMode;
  canPrompt?: boolean;
  bypassAvailable?: boolean;
  additionalWorkingDirectories?: string[];
  planDirectoryPath?: string;
  rules?: Partial<PermissionRuleSet>;
}): PermissionContext {
  return {
    mode: options.mode ?? "default",
    canPrompt: options.canPrompt ?? false,
    bypassAvailable: options.bypassAvailable ?? false,
    cwd: options.cwd,
    additionalWorkingDirectories: options.additionalWorkingDirectories ?? [],
    ...(options.planDirectoryPath ? { planDirectoryPath: options.planDirectoryPath } : {}),
    rules: {
      ...emptyPermissionRuleSet(),
      ...options.rules,
    },
  };
}
