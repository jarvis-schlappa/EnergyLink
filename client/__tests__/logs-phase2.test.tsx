// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import {
  loadFromStorage,
  loadFromUrlParams,
  saveToStorage,
  isValidCategory,
  isValidFilterLevel,
  STORAGE_KEY,
} from "@/hooks/use-persistent-filter";
import type { LogCategory } from "@/components/logs/LogFilterCard";
import { ALL_CATEGORIES } from "@/components/logs/LogFilterCard";
import type { FilterLevel } from "@/hooks/use-persistent-filter";

// ── Helper: mock localStorage ──────────────────────────────────────────

function mockLocalStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      for (const key of Object.keys(store)) delete store[key];
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
    _store: store,
  };
}

// ── Validation Functions ───────────────────────────────────────────────

describe("isValidFilterLevel", () => {
  it("accepts valid filter levels", () => {
    const validLevels: FilterLevel[] = [
      "all",
      "trace",
      "debug",
      "info",
      "warning",
      "error",
    ];
    for (const level of validLevels) {
      expect(isValidFilterLevel(level)).toBe(true);
    }
  });

  it("rejects invalid filter levels", () => {
    expect(isValidFilterLevel("unknown")).toBe(false);
    expect(isValidFilterLevel("")).toBe(false);
    expect(isValidFilterLevel(null)).toBe(false);
    expect(isValidFilterLevel(42)).toBe(false);
    expect(isValidFilterLevel(undefined)).toBe(false);
  });
});

describe("isValidCategory", () => {
  it("accepts all known categories", () => {
    for (const cat of ALL_CATEGORIES) {
      expect(isValidCategory(cat)).toBe(true);
    }
  });

  it("rejects unknown categories", () => {
    expect(isValidCategory("unknown-cat")).toBe(false);
    expect(isValidCategory("")).toBe(false);
    expect(isValidCategory(null)).toBe(false);
    expect(isValidCategory(123)).toBe(false);
  });
});

// ── saveToStorage ──────────────────────────────────────────────────────

describe("saveToStorage", () => {
  let mockStore: ReturnType<typeof mockLocalStorage>;

  beforeEach(() => {
    mockStore = mockLocalStorage();
    Object.defineProperty(globalThis, "localStorage", {
      value: mockStore,
      writable: true,
    });
  });

  it("saves filter state to localStorage", () => {
    const state = {
      filterLevel: "error" as FilterLevel,
      selectedCategories: ["wallbox"] as LogCategory[],
      textFilter: "connection",
    };
    saveToStorage(state);

    expect(mockStore.setItem).toHaveBeenCalledWith(
      STORAGE_KEY,
      JSON.stringify(state),
    );
  });

  it("saves empty state correctly", () => {
    const state = {
      filterLevel: "all" as FilterLevel,
      selectedCategories: [] as LogCategory[],
      textFilter: "",
    };
    saveToStorage(state);

    expect(mockStore.setItem).toHaveBeenCalledWith(
      STORAGE_KEY,
      JSON.stringify(state),
    );
  });

  it("handles localStorage errors silently", () => {
    mockStore.setItem.mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    // Should not throw
    expect(() =>
      saveToStorage({
        filterLevel: "all",
        selectedCategories: [],
        textFilter: "",
      }),
    ).not.toThrow();
  });
});

// ── loadFromStorage ────────────────────────────────────────────────────

describe("loadFromStorage", () => {
  let mockStore: ReturnType<typeof mockLocalStorage>;

  beforeEach(() => {
    mockStore = mockLocalStorage();
    Object.defineProperty(globalThis, "localStorage", {
      value: mockStore,
      writable: true,
    });
  });

  it("returns null when nothing is stored", () => {
    expect(loadFromStorage()).toBeNull();
  });

  it("loads valid filter state from localStorage", () => {
    const state = {
      filterLevel: "error",
      selectedCategories: ["wallbox", "system"],
      textFilter: "test",
    };
    mockStore._store[STORAGE_KEY] = JSON.stringify(state);

    const result = loadFromStorage();
    expect(result).toEqual(state);
  });

  it("ignores invalid categories from stored data", () => {
    const state = {
      filterLevel: "info",
      selectedCategories: ["wallbox", "invalid-cat", "system"],
      textFilter: "",
    };
    mockStore._store[STORAGE_KEY] = JSON.stringify(state);

    const result = loadFromStorage();
    expect(result?.selectedCategories).toEqual(["wallbox", "system"]);
  });

  it("ignores invalid filter level from stored data", () => {
    const state = {
      filterLevel: "bogus",
      selectedCategories: ["wallbox"],
      textFilter: "hello",
    };
    mockStore._store[STORAGE_KEY] = JSON.stringify(state);

    const result = loadFromStorage();
    expect(result?.filterLevel).toBeUndefined();
    expect(result?.selectedCategories).toEqual(["wallbox"]);
    expect(result?.textFilter).toBe("hello");
  });

  it("handles corrupted JSON gracefully", () => {
    mockStore._store[STORAGE_KEY] = "not-json{{{";
    expect(loadFromStorage()).toBeNull();
  });

  it("handles null stored value gracefully", () => {
    mockStore._store[STORAGE_KEY] = "null";
    expect(loadFromStorage()).toBeNull();
  });

  it("handles array stored value gracefully", () => {
    mockStore._store[STORAGE_KEY] = "[1,2,3]";
    expect(loadFromStorage()).toBeNull();
  });
});

// ── loadFromUrlParams ──────────────────────────────────────────────────

describe("loadFromUrlParams", () => {
  const originalLocation = window.location;

  function setSearch(search: string) {
    Object.defineProperty(window, "location", {
      value: { ...originalLocation, search },
      writable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
    });
  });

  it("returns null when no URL params are present", () => {
    setSearch("");
    expect(loadFromUrlParams()).toBeNull();
  });

  it("parses level from URL", () => {
    setSearch("?level=error");
    const result = loadFromUrlParams();
    expect(result?.filterLevel).toBe("error");
  });

  it("parses category from URL (single)", () => {
    setSearch("?category=wallbox");
    const result = loadFromUrlParams();
    expect(result?.selectedCategories).toEqual(["wallbox"]);
  });

  it("parses categories from URL (comma-separated)", () => {
    setSearch("?category=wallbox,system,e3dc");
    const result = loadFromUrlParams();
    expect(result?.selectedCategories).toEqual(["wallbox", "system", "e3dc"]);
  });

  it("filters invalid categories from URL", () => {
    setSearch("?category=wallbox,invalid,system");
    const result = loadFromUrlParams();
    expect(result?.selectedCategories).toEqual(["wallbox", "system"]);
  });

  it("parses text query from URL", () => {
    setSearch("?q=connection+error");
    const result = loadFromUrlParams();
    expect(result?.textFilter).toBe("connection error");
  });

  it("parses combined URL params", () => {
    setSearch("?level=warning&category=wallbox&q=timeout");
    const result = loadFromUrlParams();
    expect(result?.filterLevel).toBe("warning");
    expect(result?.selectedCategories).toEqual(["wallbox"]);
    expect(result?.textFilter).toBe("timeout");
  });

  it("ignores invalid level in URL", () => {
    setSearch("?level=bogus");
    // level is invalid, no other params → null
    expect(loadFromUrlParams()).toBeNull();
  });
});

// ── Virtual Scrolling (Virtuoso integration) ───────────────────────────

describe("Virtual Scrolling - Virtuoso", () => {
  it("Virtuoso component can be imported", async () => {
    const { Virtuoso } = await import("react-virtuoso");
    expect(Virtuoso).toBeDefined();
  });

  it("Virtuoso renders with data", async () => {
    const { Virtuoso } = await import("react-virtuoso");
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: `item-${i}`,
      text: `Item ${i}`,
    }));

    const { container } = render(
      <div style={{ height: "400px", overflow: "auto" }}>
        <Virtuoso
          data={items}
          itemContent={(index, item) => (
            <div data-testid={`virt-item-${item.id}`}>{item.text}</div>
          )}
          style={{ height: "400px" }}
        />
      </div>,
    );

    // Virtuoso should render a container element
    expect(container.querySelector("[data-testid]")).not.toBeNull();
  });

  it("Virtuoso does NOT render all 1000 items at once (virtualizes)", async () => {
    // In jsdom, Virtuoso can't measure viewport so renders 0 items.
    // This test verifies the component mounts without rendering all items.
    const { Virtuoso } = await import("react-virtuoso");
    const TOTAL_ITEMS = 1000;
    const items = Array.from({ length: TOTAL_ITEMS }, (_, i) => ({
      id: `item-${i}`,
      text: `Item ${i}`,
    }));

    const { container } = render(
      <div style={{ height: "400px", overflow: "auto" }}>
        <Virtuoso
          data={items}
          itemContent={(index, item) => (
            <div className="virt-item" style={{ height: 50 }}>
              {item.text}
            </div>
          )}
          style={{ height: "400px" }}
        />
      </div>,
    );

    // Key assertion: Virtuoso should NOT render all 1000 items
    // (in jsdom it renders 0 because it can't measure; in a real browser ~20)
    const renderedItems = container.querySelectorAll(".virt-item");
    expect(renderedItems.length).toBeLessThan(TOTAL_ITEMS);
  });

  it("Virtuoso renders with empty data", async () => {
    const { Virtuoso } = await import("react-virtuoso");

    const { container } = render(
      <div style={{ height: "400px", overflow: "auto" }}>
        <Virtuoso
          data={[]}
          itemContent={(index, item) => <div>should not render</div>}
          style={{ height: "400px" }}
        />
      </div>,
    );

    // Should not crash
    expect(container).toBeDefined();
  });
});
