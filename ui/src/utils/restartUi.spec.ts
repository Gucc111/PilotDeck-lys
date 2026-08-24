import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollHealthAndReload, restartAndReload, showRestartSplash } from "./restartUi";

function healthResponse(payload: unknown = {}) {
  return {
    ok: true,
    json: async () => payload,
  } as Response;
}

function statusResponse(ok: boolean) {
  return {
    ok,
    json: async () => ({}),
  } as Response;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("restartUi", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
    document.title = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
  });

  it("renders the restart splash and updates the document title", () => {
    showRestartSplash({
      title: "Restarting now",
      description: "Back soon",
    });

    expect(document.title).toBe("Restarting now");
    expect(document.body.textContent).toContain("Restarting now");
    expect(document.body.textContent).toContain("Back soon");
  });

  it("shows the splash before calling the restart request", async () => {
    const requestRestart = vi.fn(() => {
      expect(document.body.textContent).toContain("Restarting PilotDeck...");
      return Promise.resolve(statusResponse(true));
    });

    restartAndReload(requestRestart, {
      fetchImpl: vi.fn().mockResolvedValue(healthResponse({ instanceId: "old" })),
      setIntervalImpl: vi.fn() as unknown as typeof window.setInterval,
    });

    await flushPromises();

    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it("keeps polling while health checks fail", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ ok: false });
    const reload = vi.fn();

    pollHealthAndReload({ fetchImpl, reload });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload when health stays on the same instance", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(healthResponse({ instanceId: "same" }));
    const reload = vi.fn();

    restartAndReload(() => Promise.resolve(statusResponse(true)), { fetchImpl, reload });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads when health reports a new instance id", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(healthResponse({ instanceId: "old" }))
      .mockResolvedValueOnce(healthResponse({ instanceId: "new" }));
    const reload = vi.fn();

    restartAndReload(() => Promise.resolve(statusResponse(true)), { fetchImpl, reload });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(2000);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads after an unavailable-to-healthy transition when no instance marker exists", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(healthResponse());
    const reload = vi.fn();

    restartAndReload(() => Promise.resolve(statusResponse(true)), { fetchImpl, reload });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows failure and does not reload when restart is rejected", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(healthResponse({ instanceId: "old" }));
    const reload = vi.fn();

    restartAndReload(() => Promise.resolve(statusResponse(false)), { fetchImpl, reload });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(4000);

    expect(reload).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Restart request was rejected");
  });

  it("continues polling when restart request disconnects and reloads on a new instance", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(healthResponse({ instanceId: "old" }))
      .mockResolvedValueOnce(healthResponse({ instanceId: "new" }));
    const reload = vi.fn();

    restartAndReload(() => Promise.reject(new Error("connection closed")), { fetchImpl, reload });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(2000);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads when baseline health fails and polling later sees a marked instance", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("baseline unavailable"))
      .mockResolvedValueOnce(healthResponse({ instanceId: "new" }));
    const reload = vi.fn();

    restartAndReload(() => Promise.resolve(statusResponse(true)), { fetchImpl, reload });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(2000);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("times out without reloading when restart is not confirmed", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(healthResponse({ instanceId: "same" }));
    const reload = vi.fn();

    restartAndReload(
      () => Promise.resolve(statusResponse(true)),
      { fetchImpl, reload, timeoutMs: 3000 },
    );

    await flushPromises();
    await vi.advanceTimersByTimeAsync(4000);

    expect(reload).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Restart was not confirmed");
  });
});
