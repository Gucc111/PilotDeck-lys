type RestartSplashCopy = {
  title?: string;
  description?: string;
  documentTitle?: string;
};

export type RestartUiStatus =
  | "restarting"
  | "request-rejected"
  | "not-confirmed"
  | "confirmed";

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
  onStatusChange?: (status: RestartUiStatus) => void;
};

type HealthPayload = {
  instanceId?: unknown;
  startedAt?: unknown;
  pid?: unknown;
};

type RestartAcceptedPayload = {
  previousInstanceId?: unknown;
  previousStartedAt?: unknown;
  previousPid?: unknown;
};

type HealthSnapshot = {
  marker: string | null;
};

type PollHealthInternalOptions = PollHealthOptions & {
  baseline?: HealthSnapshot | null;
  onStatusChange?: (status: RestartUiStatus) => void;
};

const DEFAULT_TIMEOUT_MS = 120_000;

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

function isResponseLike(value: unknown): value is Response {
  return Boolean(
    value
    && typeof value === "object"
    && "ok" in value
    && typeof (value as { ok?: unknown }).ok === "boolean",
  );
}

function markerFromRestartPayload(payload: RestartAcceptedPayload): HealthSnapshot | null {
  if (typeof payload.previousInstanceId === "string" && payload.previousInstanceId) {
    return {
      marker: `instance:${payload.previousInstanceId}`,
    };
  }

  const pid = typeof payload.previousPid === "number" || typeof payload.previousPid === "string"
    ? String(payload.previousPid)
    : "";
  const startedAt = typeof payload.previousStartedAt === "string" ? payload.previousStartedAt : "";
  if (pid && startedAt) {
    return {
      marker: `legacy:${pid}:${startedAt}`,
    };
  }

  return null;
}

async function readRestartBaseline(value: unknown): Promise<HealthSnapshot | null> {
  if (!isResponseLike(value) || !value.ok) return null;

  try {
    const payload = await value.clone().json() as RestartAcceptedPayload;
    return markerFromRestartPayload(payload);
  } catch {
    return null;
  }
}

export function pollHealthAndReload({
  fetchImpl = fetch,
  intervalMs = 2000,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  reload = () => window.location.reload(),
  setIntervalImpl = window.setInterval,
  clearIntervalImpl = window.clearInterval,
  baseline = null,
  onStatusChange,
}: PollHealthInternalOptions = {}) {
  let sawUnavailable = false;
  const startedAtMs = Date.now();
  const poll = setIntervalImpl(() => {
    void (async () => {
      if (Date.now() - startedAtMs >= timeoutMs) {
        clearIntervalImpl(poll);
        onStatusChange?.("not-confirmed");
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
            onStatusChange?.("confirmed");
            reload();
          }
          return;
        }

        if (baseline && !baseline.marker && snapshot.marker) {
          clearIntervalImpl(poll);
          onStatusChange?.("confirmed");
          reload();
          return;
        }

        if (!baseline && sawUnavailable && snapshot.marker) {
          clearIntervalImpl(poll);
          onStatusChange?.("confirmed");
          reload();
          return;
        }

        if (!baseline?.marker && !snapshot.marker && sawUnavailable) {
          clearIntervalImpl(poll);
          onStatusChange?.("confirmed");
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
    options.onStatusChange?.("restarting");
    if (options.copy?.documentTitle || options.copy?.title) {
      document.title = options.copy.documentTitle ?? options.copy.title ?? document.title;
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    let baseline: HealthSnapshot | null = null;
    try {
      baseline = await readHealthSnapshot(fetchImpl);
    } catch {
      baseline = null;
    }
    try {
      const restartResponse = await requestRestart();
      if (!hasAcceptedRestart(restartResponse)) {
        options.onStatusChange?.("request-rejected");
        return;
      }
      baseline = await readRestartBaseline(restartResponse) ?? baseline;
    } catch {
      // The restart request can be interrupted when the server exits.
    }

    pollHealthAndReload({ ...options, baseline, onStatusChange: options.onStatusChange });
  })();
}
