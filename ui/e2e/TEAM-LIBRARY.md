# Team library browser smoke tests

These scripts exercise the real UI, Express routes, WebSocket Gateway, and filesystem storage. The fixture rejects and records any attempted model call; configuration management must create neither chats nor model requests. Use a fresh temporary directory for each run. Run the following commands from the repository root in separate terminals.

1. Start the isolated Gateway:

   ```sh
   export PILOTDECK_TEAM_FIXTURE="$(mktemp -d /tmp/pilotdeck-team-web-XXXXXX)"
   export PILOT_HOME="$PILOTDECK_TEAM_FIXTURE/home"
   export WORKSPACES_ROOT="$PILOTDECK_TEAM_FIXTURE/workspaces"
   node --import tsx tests/team/config-web-fixture.ts
   ```

2. Use the same `PILOTDECK_TEAM_FIXTURE`, `PILOT_HOME`, and `WORKSPACES_ROOT` in the Express terminal. Create an empty auth database first so the application does not copy its legacy local auth database into the fixture:

   ```sh
   touch "$PILOT_HOME/auth.db"
   PILOTDECK_GATEWAY_URL=ws://127.0.0.1:18973/ws \
     PILOTDECK_DISABLE_LOCAL_AUTH=1 HOST=127.0.0.1 SERVER_PORT=3097 VITE_PORT=5197 \
     node --import tsx ui/server/index.js
   ```

3. Start Vite:

   ```sh
   HOST=127.0.0.1 SERVER_PORT=3097 pnpm --dir ui exec vite --host 127.0.0.1 --port 5197 --strictPort
   ```

4. Run the scripts in order, with `PILOTDECK_TEAM_FIXTURE` pointing to the same directory:

   ```sh
   node ui/e2e/team-library.live.smoke.mjs
   node ui/e2e/team-library-responsive.smoke.mjs
   ```

The first script creates profiles and Teams, tests both fork operations and explicit profile updates, and reloads the saved configuration. It verifies that no start-conversation controls, conversation state, chat transcripts, or model calls exist. The second checks the configuration library, Team details, and profile editor on a mobile viewport in dark mode. Screenshots and persistent configuration remain in the fixture directory for inspection. Stop the three owned processes after testing and remove only that temporary directory when the evidence is no longer needed.

Ports can be changed with `PILOTDECK_TEAM_GATEWAY_PORT` for the Gateway, normal `SERVER_PORT`/Vite arguments for the Web servers, and `PILOTDECK_TEAM_UI_URL` for the browser scripts.
