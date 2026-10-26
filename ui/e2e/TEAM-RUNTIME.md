# Team runtime browser acceptance

This smoke test uses the real React app, Express bridge, authenticated Gateway WebSocket, Agent loop, tools and persistent storage. Its deterministic model fixture produces two delegated tasks and a peer message explicitly relayed by the Leader. It does not call an external model or assess real-model decision quality.

Use an empty temporary directory and the same environment in the three terminals below. Do not point the fixture at a real PilotDeck home.

```sh
export PILOTDECK_TEAM_FIXTURE="$(mktemp -d /tmp/pilotdeck-team-runtime-XXXXXX)"
export PILOT_HOME="$PILOTDECK_TEAM_FIXTURE/home"
export WORKSPACES_ROOT="$PILOTDECK_TEAM_FIXTURE/workspaces"
node --import tsx tests/team/runtime-web-fixture.ts
```

Start the bridge after the fixture is ready:

```sh
touch "$PILOT_HOME/auth.db"
PILOTDECK_GATEWAY_URL=ws://127.0.0.1:18974/ws \
  PILOTDECK_DISABLE_LOCAL_AUTH=1 HOST=127.0.0.1 SERVER_PORT=3098 VITE_PORT=5198 \
  node --import tsx ui/server/index.js
```

Start the frontend:

```sh
SERVER_PORT=3098 pnpm --dir ui exec vite --host 127.0.0.1 --port 5198 --strictPort
```

Run the full workflow:

```sh
PILOTDECK_TEAM_UI_URL=http://127.0.0.1:5198 node ui/e2e/team-runtime.live.smoke.mjs
```

The fixture seeds **Release review team**, with **Release lead**, **Code reviewer** and **Release tester**. Assertions cover choosing a Team in the composer, zero model calls before sending, two completed tasks, explicit peer-message relay, the final answer in the main chat, one public transcript, refresh, visible task/message records and desktop/mobile themes. Screenshots and `browser-runtime-result.json` remain in the temporary directory.

The fixture supports restarting the Gateway against the same temporary home. After the full workflow passes, stop and restart the owned Gateway fixture (and bridge if needed), keeping `PILOTDECK_TEAM_FIXTURE` and `PILOT_HOME` unchanged. Then run the read-only reopen mode:

```sh
PILOTDECK_TEAM_REOPEN_ONLY=1 PILOTDECK_TEAM_UI_URL=http://127.0.0.1:5198 \
  node ui/e2e/team-runtime.live.smoke.mjs
```

This mode opens `currentUrl` from `browser-runtime-result.json`; it never sends a task or selects a new Team. It checks restored Team identity, both completed tasks, the Leader relay in the panel, the same single public transcript with unchanged content, and no additional entries in `model-requests.jsonl`. It saves `restart-team-results.png`, `restart-team-chat.png` and `browser-runtime-restart-result.json` in the fixture directory. The original workflow result is preserved.

Do not rerun the normal zero-model-before-send smoke against a populated home. Stop only the owned fixture, bridge and Vite processes after validation.

For isolated UI edge cases (empty model catalog, long errors, mobile menu and stop), run:

```sh
pnpm --dir ui exec playwright test --config e2e/team-mode.config.mjs
```

## Current runtime expectations (2026-10-25)

- Delegation acknowledges durable admission without waiting for the member result. Leader lifecycle and `team_collect` queries are unchanged; the model is not instructed to end its turn after delegating.
- Leader and running Teammates receive internal messages at existing safe model/tool boundaries. An already sent model request is unchanged, tool call/result pairing remains intact, and internal messages are not rendered as human bubbles. Only genuinely started idle Leader follow-up turns consume the automatic wake-up budget.
- Abort stops the whole Team. Pending internal messages, notifications and Team user queue entries expire; they are not merely paused. Cleanup remains `stopping` until execution exits. An uncooperative tool must not yield a false stopped acknowledgment. Expired user input can be explicitly put back in the composer with preserved attachment references and a fresh request token.
- A Gateway restart interrupts all unfinished old work, including unclaimed queued work, and invalidates old messages/notifications without waking the Leader. A Web bridge restart also invalidates queued Team inputs, including drafts with only a Team selection. Browser reconnect to a live service does not invalidate the run. Completed results and chat history remain readable.
- Automatic workspace checkpoints and rollback are removed. All legacy checkpoint operations, including list/diff and the old Git branch of that API, explicitly reject with the removed-feature error. Independent Git operations and file artifacts remain supported.

The smoke above does not cover every failure/race branch. Controlled bridge/UI tests exercise expired queues, generation fencing, interrupted draft sends and internal-message rendering. The isolated layout checks in `docs/testing/reports/2026-10-25-team-runtime-assets/` render actual components with fixture state; they do not prove a real Team run or model result. Do not describe an unexecuted smoke as passed.
