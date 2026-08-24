type RestartSplashCopy = {
  title?: string;
  description?: string;
  documentTitle?: string;
};

type PollHealthOptions = {
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  timeoutMs?: number;
  reload?: () => void;
  setIntervalImpl?: typeof window.setInterval;
  clearIntervalImpl?: typeof window.clearInterval;
};

type RestartAndReloadOptions = PollHealthOptions & {
  copy?: RestartSplashCopy;
};

type HealthPayload = {
  instanceId?: unknown;
  startedAt?: unknown;
  pid?: unknown;
};

type HealthSnapshot = {
  marker: string | null;
};

type PollHealthInternalOptions = PollHealthOptions & {
  baseline?: HealthSnapshot | null;
  sawUnavailableBeforePolling?: boolean;
};

const DEFAULT_TITLE = "Restarting PilotDeck...";
const DEFAULT_DESCRIPTION = "Page will reload automatically when server is ready.";
const DEFAULT_TIMEOUT_MS = 120_000;

function renderRestartFailure(message: string) {
  const errorEl = document.createElement("p");
  errorEl.textContent = message;
  errorEl.style.cssText = "color:#f87171;font-size:0.85rem;margin:16px 0 0";

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Refresh";
  button.style.cssText =
    "margin-top:14px;border:1px solid #525252;background:#171717;color:#e5e5e5;border-radius:6px;padding:6px 12px;cursor:pointer";
  button.addEventListener("click", () => window.location.reload());

  document.body.querySelector("div")?.append(errorEl, button);
}

async function readHealthSnapshot(fetchImpl: typeof fetch): Promise<HealthSnapshot | null> {
  const res = await fetchImpl("/health");
  if (!res.ok) return null;

  let payload: HealthPayload = {};
  try {
    payload = await res.json();
  } catch {
    payload = {};
  }

  if (typeof payload.instanceId === "string" && payload.instanceId) {
    return {
      marker: `instance:${payload.instanceId}`,
    };
  }

  const pid = typeof payload.pid === "number" || typeof payload.pid === "string"
    ? String(payload.pid)
    : "";
  const startedAt = typeof payload.startedAt === "string" ? payload.startedAt : "";
  if (pid && startedAt) {
    return {
      marker: `legacy:${pid}:${startedAt}`,
    };
  }

  return {
    marker: null,
  };
}

function hasAcceptedRestart(value: unknown) {
  if (
    value
    && typeof value === "object"
    && "ok" in value
    && typeof (value as { ok?: unknown }).ok === "boolean"
  ) {
    return (value as { ok: boolean }).ok;
  }
  return true;
}

export function showRestartSplash(copy: RestartSplashCopy = {}) {
  const title = copy.title ?? DEFAULT_TITLE;
  const description = copy.description ?? DEFAULT_DESCRIPTION;

  document.title = copy.documentTitle ?? title;
  document.body.innerHTML = "";
  document.body.style.cssText =
    "margin:0;background:#0a0a0a;display:flex;align-items:center;justify-content:center;height:100vh";

  const container = document.createElement("div");
  container.style.cssText = "text-align:center;font-family:system-ui,-apple-system,sans-serif";

  const spinner = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  spinner.setAttribute("viewBox", "0 0 24 24");
  spinner.setAttribute("fill", "none");
  spinner.setAttribute("stroke", "#888");
  spinner.setAttribute("stroke-width", "2");
  spinner.style.cssText =
    "width:40px;height:40px;margin-bottom:16px;animation:restart-ui-spin 1s linear infinite";

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M21 12a9 9 0 1 1-6.22-8.56");
  spinner.appendChild(path);

  const titleEl = document.createElement("p");
  titleEl.textContent = title;
  titleEl.style.cssText = "color:#ccc;font-size:1.1rem;margin:0 0 8px";

  const descriptionEl = document.createElement("p");
  descriptionEl.textContent = description;
  descriptionEl.style.cssText = "color:#666;font-size:0.8rem;margin:0";

  const style = document.createElement("style");
  style.textContent = "@keyframes restart-ui-spin{to{transform:rotate(360deg)}}";

  container.append(spinner, titleEl, descriptionEl);
  document.body.append(container, style);
}

export function pollHealthAndReload({
  fetchImpl = fetch,
  intervalMs = 2000,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  reload = () => window.location.reload(),
  setIntervalImpl = window.setInterval,
  clearIntervalImpl = window.clearInterval,
  baseline = null,
  sawUnavailableBeforePolling = false,
}: PollHealthInternalOptions = {}) {
  let sawUnavailable = sawUnavailableBeforePolling;
  const startedAtMs = Date.now();
  const poll = setIntervalImpl(() => {
    void (async () => {
      if (Date.now() - startedAtMs >= timeoutMs) {
        clearIntervalImpl(poll);
        renderRestartFailure("Restart was not confirmed. Refresh the page or try again.");
        return;
      }

      try {
        const snapshot = await readHealthSnapshot(fetchImpl);
        if (!snapshot) {
          sawUnavailable = true;
          return;
        }

        if (baseline?.marker && snapshot.marker) {
          if (snapshot.marker !== baseline.marker) {
            clearIntervalImpl(poll);
            reload();
          }
          return;
        }

        if (baseline && !baseline.marker && snapshot.marker) {
          clearIntervalImpl(poll);
          reload();
          return;
        }

        if (!baseline && sawUnavailable && snapshot.marker) {
          clearIntervalImpl(poll);
          reload();
          return;
        }

        if (!baseline?.marker && !snapshot.marker && sawUnavailable) {
          clearIntervalImpl(poll);
          reload();
        }
      } catch {
        sawUnavailable = true;
      }
    })();
  }, intervalMs);

  return poll;
}

export function restartAndReload(
  requestRestart: () => Promise<unknown>,
  options: RestartAndReloadOptions = {},
) {
  void (async () => {
    const fetchImpl = options.fetchImpl ?? fetch;
    let baseline: HealthSnapshot | null = null;
    let sawUnavailable = false;
    try {
      baseline = await readHealthSnapshot(fetchImpl);
    } catch {
      sawUnavailable = true;
      baseline = null;
    }

    showRestartSplash(options.copy);

    try {
      const restartResponse = await requestRestart();
      if (!hasAcceptedRestart(restartResponse)) {
        renderRestartFailure("Restart request was rejected. Refresh the page or try again.");
        return;
      }
    } catch {
      // The restart request can be interrupted when the server exits.
    }

    pollHealthAndReload({ ...options, baseline, sawUnavailableBeforePolling: sawUnavailable });
  })();
}
