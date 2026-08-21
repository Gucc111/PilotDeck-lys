import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopVersionCheckResult } from "../../Settings";
import { authenticatedFetch } from "../../../../utils/api";
import AboutSections from ".";

vi.mock("../../../../utils/api", () => ({
  authenticatedFetch: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const mockedFetch = vi.mocked(authenticatedFetch);

function responseJson(payload: unknown, ok = true) {
  return {
    ok,
    json: async () => payload,
  } as Response;
}

function renderAbout(versionInfo: Partial<DesktopVersionCheckResult> = {}) {
  const defaults: DesktopVersionCheckResult = {
    mode: "web",
    hasUpdate: false,
    checkUnavailable: false,
    currentVersion: "current",
    latestVersion: null,
    latestPublishedAt: null,
    buildTime: null,
  };

  return render(
    <AboutSections
      title="About"
      versionInfo={{ ...defaults, ...versionInfo }}
      checkingVersion={false}
    />,
  );
}

describe("AboutSections web update status recovery", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  async function flushEffects() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function advancePollingInterval() {
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("restores the restart action when the previous update needs a restart", async () => {
    mockedFetch.mockResolvedValue(responseJson({
      updateInProgress: false,
      lastUpdateResult: {
        success: true,
        alreadyUpToDate: false,
        needsRestart: true,
      },
    }));

    renderAbout({ hasUpdate: false });

    expect(await screen.findByRole("button", { name: "about.restartToApply" })).toBeTruthy();
    expect(mockedFetch).toHaveBeenCalledWith("/api/update/status");
  });

  it("shows updating and polls when an update is already in progress", async () => {
    vi.useFakeTimers();
    mockedFetch.mockResolvedValue(responseJson({
      updateInProgress: true,
      lastUpdateResult: null,
    }));

    renderAbout({ hasUpdate: false });
    await flushEffects();

    const updateButton = screen.getByRole("button", { name: "about.updating" }) as HTMLButtonElement;
    expect(updateButton.disabled).toBe(true);

    await advancePollingInterval();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("switches from in-progress polling to restart when the update completes", async () => {
    vi.useFakeTimers();
    mockedFetch
      .mockResolvedValueOnce(responseJson({
        updateInProgress: true,
        lastUpdateResult: null,
      }))
      .mockResolvedValueOnce(responseJson({
        updateInProgress: false,
        lastUpdateResult: {
          success: true,
          alreadyUpToDate: false,
          needsRestart: true,
        },
      }));

    renderAbout({ hasUpdate: false });
    await flushEffects();

    const updateButton = screen.getByRole("button", { name: "about.updating" }) as HTMLButtonElement;
    expect(updateButton.disabled).toBe(true);

    await advancePollingInterval();

    expect(screen.getByRole("button", { name: "about.restartToApply" })).toBeTruthy();
  });

  it("switches from in-progress polling to failed status when the update fails", async () => {
    vi.useFakeTimers();
    mockedFetch
      .mockResolvedValueOnce(responseJson({
        updateInProgress: true,
        lastUpdateResult: null,
      }))
      .mockResolvedValueOnce(responseJson({
        updateInProgress: false,
        lastUpdateResult: {
          success: false,
          error: "build failed",
        },
      }));

    renderAbout({ hasUpdate: false });
    await flushEffects();

    const updateButton = screen.getByRole("button", { name: "about.updating" }) as HTMLButtonElement;
    expect(updateButton.disabled).toBe(true);

    await advancePollingInterval();

    expect(screen.getByText("settingsPage.about.status.unavailable")).toBeTruthy();
  });
});
