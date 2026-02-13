// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ErrorBoundary } from "@/components/ErrorBoundary";

function ProblemChild() {
  throw new Error("Test error");
}

function GoodChild() {
  return <div>All good</div>;
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("renders children when no error", () => {
    render(
      <ErrorBoundary>
        <GoodChild />
      </ErrorBoundary>,
    );
    expect(screen.getByText("All good")).toBeDefined();
  });

  it("renders fallback UI when child throws", () => {
    render(
      <ErrorBoundary>
        <ProblemChild />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Etwas ist schiefgelaufen")).toBeDefined();
    expect(screen.getByText("Test error")).toBeDefined();
    expect(screen.getByText("Seite neu laden")).toBeDefined();
    expect(screen.getByText("Erneut versuchen")).toBeDefined();
  });

  it("resets error state when 'Erneut versuchen' is clicked", async () => {
    let shouldThrow = true;

    function MaybeThrow() {
      if (shouldThrow) throw new Error("Conditional error");
      return <div>Recovered</div>;
    }

    render(
      <ErrorBoundary>
        <MaybeThrow />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Etwas ist schiefgelaufen")).toBeDefined();

    shouldThrow = false;
    const user = userEvent.setup();
    await user.click(screen.getByText("Erneut versuchen"));

    expect(screen.getByText("Recovered")).toBeDefined();
  });

  it("calls window.location.reload on 'Seite neu laden'", async () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      value: { reload: reloadMock },
      writable: true,
    });

    render(
      <ErrorBoundary>
        <ProblemChild />
      </ErrorBoundary>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByText("Seite neu laden"));
    expect(reloadMock).toHaveBeenCalled();
  });
});
