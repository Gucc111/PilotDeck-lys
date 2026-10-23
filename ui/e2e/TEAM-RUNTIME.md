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
