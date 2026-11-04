---
name: pilotdeck-team-config
description: Create, inspect, validate, and edit PilotDeck Leader, Teammate, and Team configurations through the local Gateway team_command API. Use when the user asks to create a team, define or edit a Leader or Teammate, assemble roles into a Team, review existing Team configuration, or validate a Team before activation. Do not edit team-library/state.json directly.
---

# PilotDeck Team Configuration

Use this skill to turn a user's Team requirements into PilotDeck configuration
through the supported Gateway API. The API is the source of truth; the
`team-library/state.json` file is an internal checksum-protected store and must
not be edited by hand.

## Operating rules

- Save through Gateway RPC method `team_command`; use the helper discovery
  actions below to find models and projects without reading secret files.
- Use the bundled `scripts/team-command.mjs` helper for Gateway WebSocket calls.
- Read the current library before editing an existing object. Match by `id`, not
  by display name.
- Keep Leader and Teammate profiles separate. A profile's role is immutable;
  create a new profile if a role needs to change.
- Generate a fresh, unique `requestToken` for every `profile_save`,
  `profile_fork`, `profile_delete`, `team_save`, `team_fork`, or `team_delete`
  request. Retrying the same request with the same token is safe; reusing a
  token with different content is rejected.
- Never write `${PILOT_HOME}/team-library/state.json` directly and never invent
  profile or Team IDs. The server generates IDs for new objects.
- Treat deletion as destructive. Before deleting a profile or Team, identify
  the object and obtain explicit user confirmation in the conversation.
- A successful save proves that the configuration passed structural and
  reference validation. It does not prove that every model, skill, tool, MCP
  server, or workspace is usable. Run `runtime_probe` when the user asks for
  readiness or before recommending activation.

## Workflow

### 1. Understand the requested Team

Start from the user's purpose, work, and approximate member descriptions. A request
such as “Create a document review team; arrange the members for me” is enough.
Design the roster, responsibilities, role system prompts, coordination instructions,
and deliverables yourself. Do not require the user to write system prompts,
provide API fields, choose internal identifiers, or tell you to validate saves.
Ask only about business choices that materially change the requested result.

Discover defaults and capabilities with the helper, using one call per input:

```json
{"action":"models"}
{"action":"projects"}
{"action":"inventory"}
```

- `models` calls `model_catalog_list` and returns configured model identifiers
  and `defaultSelection` without credentials. Unless the user requests a
  particular model, use that default explicitly for each new profile. Never
  select an arbitrary catalog model just because its name sounds suitable.
  If the default is unavailable or is known to have failed in this conversation,
  use the current conversation's successful model if its exact identifiers are
  known and listed; otherwise ask for a model choice. Do not read `pilotdeck.yaml`,
  token files, or provider secrets to discover models.
- `projects` calls `list_projects`. Use the returned `projectKey` as the registered
  Gateway project key; do not invent one from a directory slug. An absolute
  directory is not necessarily a registered project. Do not inspect internal
  project registries or source code to resolve a missing project.
- Choose only capabilities returned by `inventory` that serve the requested
  work. Do not assume a search tool or MCP server exists. Explain any material
  limitation, such as a fact checker that cannot browse external sources.
- Default workspace to `{"mode":"team"}`, permissions to `default`, and Team
  `defaultProjectKey` to `null` when the user has not selected a project. Creating
  a reusable Team in a general conversation does not require a project.

A clear creation or editing request authorizes its non-destructive saves. Briefly
explain the resulting member responsibilities and material defaults in your reply.
Ask before replacing an unrelated Team or deleting anything.

### 2. Inspect the existing library

Run:

```bash
node /absolute/path/to/pilotdeck-team-config/scripts/team-command.mjs <<'JSON'
{"action":"library"}
JSON
```

Use the actual absolute path of this skill's `scripts/team-command.mjs` file.
The result contains `profiles` and `teams`. Reuse an existing ID only when the
user asked to edit that object or clearly identified it. If the user asks for a
new Team, create new profiles unless they explicitly request reuse.

### 3. Create or edit profiles

Use `profile_save`. Omit `id` to create a profile; include the existing `id`
to edit it. Saves replace the full configuration: on edits preserve every existing
field that the user did not ask to change. A valid profile has this shape:

```json
{
  "action": "profile_save",
  "role": "leader",
  "requestToken": "<fresh-unique-token>",
  "config": {
    "displayName": "Research Lead",
    "description": "Coordinates research and synthesis.",
    "systemPrompt": "You coordinate the research work and produce the final synthesis.",
    "model": {
      "mode": "model",
      "provider": "<configured-provider>",
      "model": "<configured-model>"
    },
    "workspace": {
      "mode": "team"
    },
    "capabilities": {
      "tools": ["read_file"],
      "skills": [],
      "mcpServers": []
    },
    "permissionMode": "default"
  }
}
```

For a fixed Teammate workspace, use:

```json
"workspace": {
  "mode": "fixed",
  "projectKey": "/absolute/path/to/existing-directory"
}
```

The returned object contains the server-generated profile `id`. Save it for
`team_save`. A Teammate fixed workspace is checked by the Gateway and must be
an existing absolute directory outside PilotDeck's general home.

### 4. Create or edit the Team

After all profile saves succeed, use `team_save` with the returned profile IDs:

```json
{
  "action": "team_save",
  "requestToken": "<fresh-unique-token>",
  "config": {
    "displayName": "Research Team",
    "description": "A small research and synthesis team.",
    "instructions": "Coordinate through the Leader. Keep tasks finite and report evidence with results.",
    "defaultProjectKey": "/absolute/path/to/project",
    "leader": {
      "id": "<leader-profile-id>"
    },
    "teammates": [
      {
        "id": "<teammate-profile-id>"
      }
    ]
  }
}
```

To edit a Team, add its existing `id` at the top level. The referenced profile
IDs must already exist and must have the correct roles. A Team needs one Leader
and between one and one hundred distinct Teammates.

### 5. Validate and report

Always read the library again after a successful save:

```bash
node /absolute/path/to/pilotdeck-team-config/scripts/team-command.mjs <<'JSON'
{"action":"library"}
JSON
```

Confirm the returned object by ID, display the resulting roster, and state
whether the operation created or edited the profile/Team.

Only probe when a registered project is selected and readiness matters. If the
user only asked to create/edit a reusable Team in a general conversation, finish
after readback and report that execution readiness has not been checked. Do not
register a project or launch Team execution solely to complete configuration.
If a probe returns a project error, stop probing and explain that a project must
be selected before execution; do not retry guessed paths or keys.

Probe against the registered project key returned by `projects`:

```bash
node /absolute/path/to/pilotdeck-team-config/scripts/team-command.mjs <<'JSON'
{
  "action": "runtime_probe",
  "team": {"id": "<team-id>"},
  "projectKey": "<registered-project-key>"
}
JSON
```

Report every probe issue. In particular, distinguish missing capabilities,
unavailable models, invalid workspaces, MCP configuration errors, and a clean
probe. A clean probe checks local configuration and credentials, not remote model
service health or actual task execution. Do not call a Team operational merely
because `team_save` or `runtime_probe` succeeded.

## API action guide

Helper-only read actions (not `team_command` actions): `models` lists the safe
model catalog and default; `projects` lists registered projects. Neither accepts
additional fields.


- `library`: list current profiles and Teams.
- `profile_save`: create or edit a Leader or Teammate.
- `profile_fork`: copy an existing profile with a new server-generated ID.
- `profile_delete`: delete an unreferenced profile; confirm first.
- `team_save`: create or edit a Team.
- `team_fork`: copy an existing Team with a new server-generated ID.
- `team_delete`: delete a Team; confirm first.
- `inventory`: inspect available project capabilities when selecting tools,
  skills, or MCP servers.
- `project_references`: check whether a project is referenced by configuration.
- `runtime_probe`: validate effective model, workspace, capabilities, and MCP
  configuration before activation.

If the Gateway is unavailable, report that configuration could not be changed.
Do not fall back to editing the state file.

## Error handling

- `TEAM_INVALID_INPUT`: correct the request shape or unsupported field.
- `TEAM_PROFILE_NOT_FOUND` / `TEAM_NOT_FOUND`: refresh `library` and use a
  current ID.
- `TEAM_ROLE_MISMATCH`: the referenced profile is not a Leader or Teammate of
  the required role.
- `TEAM_REFERENCED`: remove the profile from every Team before deletion.
- `TEAM_PROJECT_REQUIRED`: choose an existing absolute directory for a fixed
  Teammate workspace.
- `TEAM_MODEL_UNAVAILABLE` or `TEAM_CAPABILITY_MISSING` from `runtime_probe`:
  revise the profile model or capabilities, save the profile, then probe again.
- `TEAM_TOKEN_CONFLICT`: generate a new request token and do not guess whether
  the conflicting mutation was applied.

When reporting errors, include the server error code and the corrective action
that is needed. Do not claim a mutation succeeded without a successful API
response and a post-save `library` readback.
