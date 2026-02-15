// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import LogFilterCard, {
  ALL_CATEGORIES,
  getCategoryLabel,
} from "@/components/logs/LogFilterCard";
import LogEntryItem from "@/components/logs/LogEntryItem";
import type { LogEntry, LogLevel } from "@shared/schema";

// ── LogFilterCard (Checkbox-List) ──────────────────────────────────────

describe("LogFilterCard", () => {
  const defaultProps = {
    filterLevel: "all" as LogLevel | "all",
    onFilterLevelChange: vi.fn(),
    textFilter: "",
    onTextFilterChange: vi.fn(),
    selectedCategories: [] as string[],
    onToggleCategory: vi.fn(),
    onClearCategories: vi.fn(),
    onRefresh: vi.fn(),
    onClearLogs: vi.fn(),
    isClearingLogs: false,
  };

  it("renders checkbox list for all categories", () => {
    render(<LogFilterCard {...defaultProps} />);
    const list = screen.getByTestId("category-checkbox-list");
    expect(list).toBeDefined();
    for (const category of ALL_CATEGORIES) {
      expect(screen.getByTestId(`category-item-${category}`)).toBeDefined();
      expect(screen.getByTestId(`checkbox-filter-${category}`)).toBeDefined();
    }
  });

  it("shows category labels correctly", () => {
    render(<LogFilterCard {...defaultProps} />);
    for (const category of ALL_CATEGORIES) {
      expect(screen.getByText(getCategoryLabel(category))).toBeDefined();
    }
  });

  it("calls onToggleCategory when checkbox is clicked", async () => {
    const onToggle = vi.fn();
    render(<LogFilterCard {...defaultProps} onToggleCategory={onToggle} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("checkbox-filter-wallbox"));
    expect(onToggle).toHaveBeenCalledWith("wallbox");
  });

  it("shows 'Alle auswählen' button when categories are selected", () => {
    render(
      <LogFilterCard {...defaultProps} selectedCategories={["wallbox"]} />,
    );
    expect(screen.getByTestId("button-clear-category-filter")).toBeDefined();
  });

  it("hides 'Alle auswählen' button when no categories are selected", () => {
    render(<LogFilterCard {...defaultProps} />);
    expect(
      screen.queryByTestId("button-clear-category-filter"),
    ).toBeNull();
  });

  it("category items have min 44px touch targets", () => {
    render(<LogFilterCard {...defaultProps} />);
    const item = screen.getByTestId("category-item-wallbox");
    expect(item.className).toContain("min-h-[44px]");
  });
});

// ── LogEntryItem (Level Icons + Fonts) ─────────────────────────────────

describe("LogEntryItem", () => {
  function makeLog(overrides: Partial<LogEntry> = {}): LogEntry {
    return {
      id: "test-1",
      timestamp: "2026-02-15T14:30:00.000Z",
      level: "info",
      category: "system",
      message: "Test message",
      ...overrides,
    };
  }

  const levels: LogLevel[] = ["error", "warning", "info", "debug", "trace"];

  it.each(levels)("renders %s level icon", (level) => {
    render(<LogEntryItem log={makeLog({ level })} />);
    expect(screen.getByTestId(`icon-${level}`)).toBeDefined();
  });

  it("renders message with text-base class", () => {
    render(<LogEntryItem log={makeLog()} />);
    const msg = screen.getByTestId("text-message-test-1");
    expect(msg.className).toContain("text-base");
  });

  it("renders details with text-sm class", () => {
    render(
      <LogEntryItem log={makeLog({ details: "some detail" })} />,
    );
    const details = screen.getByTestId("text-details-test-1");
    expect(details.className).toContain("text-sm");
  });

  it("uses p-5 padding on card content", () => {
    const { container } = render(<LogEntryItem log={makeLog()} />);
    const cardContent = container.querySelector("[class*='p-5']");
    expect(cardContent).not.toBeNull();
  });

  it("renders level icon container with background", () => {
    render(<LogEntryItem log={makeLog({ level: "error" })} />);
    const container = screen.getByTestId("level-icon-container-test-1");
    expect(container.className).toContain("rounded-full");
    expect(container.className).toContain("bg-destructive/10");
  });

  it("renders category badge", () => {
    render(<LogEntryItem log={makeLog({ category: "wallbox" })} />);
    expect(screen.getByTestId("badge-category-wallbox")).toBeDefined();
  });

  it("renders timestamp", () => {
    render(<LogEntryItem log={makeLog()} />);
    expect(screen.getByTestId("text-timestamp-test-1")).toBeDefined();
  });

  it("hides details when not provided", () => {
    render(<LogEntryItem log={makeLog({ details: undefined })} />);
    expect(screen.queryByTestId("text-details-test-1")).toBeNull();
  });
});
