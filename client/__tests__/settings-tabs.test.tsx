// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Polyfill ResizeObserver for jsdom
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
}

// Mock PointerEvent for Radix UI
if (typeof globalThis.PointerEvent === "undefined") {
  class PointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
    }
  }
  globalThis.PointerEvent = PointerEvent as any;
}

// Mock Element.hasPointerCapture for Radix
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock settings data
const mockSettings = {
  wallboxIp: "192.168.40.16",
  e3dcIp: "192.168.40.17",
  pvSurplusOnUrl: "",
  pvSurplusOffUrl: "",
  nightChargingSchedule: { enabled: false, startTime: "00:00", endTime: "05:00" },
  e3dc: {
    enabled: true,
    prefix: "",
    dischargeLockEnableCommand: "",
    dischargeLockDisableCommand: "",
    gridChargeEnableCommand: "",
    gridChargeDisableCommand: "",
    gridChargeDuringNightCharging: false,
    modbusPauseSeconds: 3,
    pollingIntervalSeconds: 10,
  },
  chargingStrategy: {
    activeStrategy: "off" as const,
    minStartPowerWatt: 1400,
    stopThresholdWatt: 1000,
    startDelaySeconds: 120,
    stopDelaySeconds: 300,
    minCurrentChangeAmpere: 1,
    minChangeIntervalSeconds: 60,
    physicalPhaseSwitch: 3 as const,
    inputX1Strategy: "max_without_battery" as const,
  },
  prowl: {
    enabled: true,
    apiKey: "test-key",
    events: {
      appStarted: false,
      chargingStarted: true,
      chargingStopped: true,
      currentAdjusted: false,
      plugConnected: false,
      plugDisconnected: false,
      batteryLockActivated: false,
      batteryLockDeactivated: false,
      gridChargingActivated: false,
      gridChargingDeactivated: false,
      gridFrequencyWarning: true,
      gridFrequencyCritical: true,
      strategyChanged: false,
      errors: false,
    },
  },
  gridFrequencyMonitor: {
    enabled: true,
    tier2Threshold: 0.15,
    tier3Threshold: 0.2,
    enableEmergencyCharging: true,
  },
  fhemSync: {
    enabled: true,
    host: "192.168.40.11",
    port: 7072,
    autoCloseGarageOnPlug: false,
  },
  demoMode: false,
  mockWallboxPhases: 3 as const,
  mockWallboxPlugStatus: 7,
};

const mockBuildInfo = {
  version: "1.0.2",
  branch: "main",
  commit: "abc1234",
  buildTime: "2026-02-26T12:00:00Z",
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        queryFn: async ({ queryKey }) => {
          const url = queryKey[0] as string;
          if (url === "/api/settings") return mockSettings;
          if (url === "/api/build-info") return mockBuildInfo;
          if (url === "/api/wallbox/status") return { state: 3, plug: 7, enableSys: 1, maxCurr: 32000, ePres: 0, eTotal: 0, power: 0 };
          return {};
        },
      },
      mutations: { retry: false },
    },
  });

  // Pre-populate cache
  queryClient.setQueryData(["/api/settings"], mockSettings);
  queryClient.setQueryData(["/api/build-info"], mockBuildInfo);

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  };
}

// Lazy import to avoid module-level fetch calls
async function importSettingsPage() {
  const mod = await import("@/pages/SettingsPage");
  return mod.default;
}

describe("Settings Tabs", () => {
  beforeEach(() => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/settings" || url.includes("/api/settings")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockSettings),
          text: () => Promise.resolve(JSON.stringify(mockSettings)),
        });
      }
      if (url === "/api/build-info" || url.includes("/api/build-info")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockBuildInfo),
          text: () => Promise.resolve(JSON.stringify(mockBuildInfo)),
        });
      }
      if (url === "/api/wallbox/status" || url.includes("/api/wallbox/status")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ state: 3, plug: 7, enableSys: 1, maxCurr: 32000, ePres: 0, eTotal: 0, power: 0 }),
          text: () => Promise.resolve("{}"),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve("{}"),
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders 4 tabs with correct labels", async () => {
    const SettingsPage = await importSettingsPage();
    const wrapper = createWrapper();

    await act(async () => {
      render(<SettingsPage />, { wrapper });
    });

    expect(screen.getByTestId("tab-wallbox")).toBeDefined();
    expect(screen.getByTestId("tab-e3dc")).toBeDefined();
    expect(screen.getByTestId("tab-fhem")).toBeDefined();
    expect(screen.getByTestId("tab-system")).toBeDefined();

    // Check labels
    expect(screen.getByTestId("tab-wallbox").textContent).toContain("Wallbox");
    expect(screen.getByTestId("tab-e3dc").textContent).toContain("E3DC");
    expect(screen.getByTestId("tab-fhem").textContent).toContain("FHEM");
    expect(screen.getByTestId("tab-system").textContent).toContain("System");
  });

  it("shows Wallbox tab content by default", async () => {
    const SettingsPage = await importSettingsPage();
    const wrapper = createWrapper();

    await act(async () => {
      render(<SettingsPage />, { wrapper });
    });

    expect(screen.getByTestId("wallbox-tab")).toBeDefined();
    expect(screen.getByTestId("input-wallbox-ip")).toBeDefined();
  });

  it("switches to E3DC tab on click", async () => {
    const SettingsPage = await importSettingsPage();
    const wrapper = createWrapper();
    const user = userEvent.setup();

    await act(async () => {
      render(<SettingsPage />, { wrapper });
    });

    await user.click(screen.getByTestId("tab-e3dc"));

    expect(screen.getByTestId("e3dc-tab")).toBeDefined();
    expect(screen.getByTestId("switch-e3dc-enabled")).toBeDefined();
  });

  it("switches to FHEM tab on click", async () => {
    const SettingsPage = await importSettingsPage();
    const wrapper = createWrapper();
    const user = userEvent.setup();

    await act(async () => {
      render(<SettingsPage />, { wrapper });
    });

    await user.click(screen.getByTestId("tab-fhem"));

    expect(screen.getByTestId("fhem-tab")).toBeDefined();
    expect(screen.getByTestId("switch-fhem-sync-enabled")).toBeDefined();
  });

  it("switches to System tab on click", async () => {
    const SettingsPage = await importSettingsPage();
    const wrapper = createWrapper();
    const user = userEvent.setup();

    await act(async () => {
      render(<SettingsPage />, { wrapper });
    });

    await user.click(screen.getByTestId("tab-system"));

    expect(screen.getByTestId("system-tab")).toBeDefined();
    expect(screen.getByTestId("switch-demo-mode")).toBeDefined();
  });

  it("shows cross-tab hint in FHEM tab", async () => {
    const SettingsPage = await importSettingsPage();
    const wrapper = createWrapper();
    const user = userEvent.setup();

    await act(async () => {
      render(<SettingsPage />, { wrapper });
    });

    await user.click(screen.getByTestId("tab-fhem"));

    const crossRef = screen.getByTestId("cross-ref-e3dc");
    expect(crossRef).toBeDefined();
    expect(crossRef.textContent).toContain("E3DC-Integration");
  });

  it("shows cross-tab hint in E3DC tab for grid frequency", async () => {
    const SettingsPage = await importSettingsPage();
    const wrapper = createWrapper();
    const user = userEvent.setup();

    await act(async () => {
      render(<SettingsPage />, { wrapper });
    });

    await user.click(screen.getByTestId("tab-e3dc"));

    const crossRef = screen.getByTestId("cross-ref-system");
    expect(crossRef).toBeDefined();
    expect(crossRef.textContent).toContain("Tab System");
  });

  it("shows Prowl events in 3 groups", async () => {
    const SettingsPage = await importSettingsPage();
    const wrapper = createWrapper();
    const user = userEvent.setup();

    await act(async () => {
      render(<SettingsPage />, { wrapper });
    });

    await user.click(screen.getByTestId("tab-system"));

    expect(screen.getByTestId("prowl-group-charging")).toBeDefined();
    expect(screen.getByTestId("prowl-group-battery")).toBeDefined();
    expect(screen.getByTestId("prowl-group-system")).toBeDefined();

    // Check group labels
    expect(screen.getByTestId("prowl-group-charging").textContent).toContain("Laden & Verbindung");
    expect(screen.getByTestId("prowl-group-battery").textContent).toContain("Batterie & Netz");
    expect(screen.getByTestId("prowl-group-system").textContent).toContain("System & Fehler");
  });

  it("shows save button only when form is dirty (WallboxTab direct)", async () => {
    const { default: WallboxTab } = await import("@/components/settings/WallboxTab");
    const onDirtyChange = vi.fn();
    const wrapper = createWrapper();
    const user = userEvent.setup();

    await act(async () => {
      render(
        <WallboxTab settings={mockSettings} onDirtyChange={onDirtyChange} />,
        { wrapper }
      );
    });

    // Initially no save button visible
    expect(screen.queryByTestId("button-save-wallbox")).toBeNull();

    // Change the IP field
    const ipInput = screen.getByTestId("input-wallbox-ip") as HTMLInputElement;
    await user.click(ipInput);
    await user.type(ipInput, "X");

    // Wait for react-hook-form to process
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    // onDirtyChange should have been called with true
    expect(onDirtyChange).toHaveBeenCalledWith(true);

    // Save button should appear
    const saveBtn = screen.queryByTestId("button-save-wallbox");
    expect(saveBtn).not.toBeNull();
  });
});
