import { useState, useEffect, useCallback, useRef } from "react";
import { ALL_CATEGORIES, type LogCategory } from "@/components/logs/LogFilterCard";
import type { LogLevel } from "@shared/schema";

const STORAGE_KEY = "energylink:logs:filter";

export type FilterLevel = LogLevel | "all";

interface FilterState {
  filterLevel: FilterLevel;
  selectedCategories: LogCategory[];
  textFilter: string;
}

const VALID_FILTER_LEVELS: FilterLevel[] = [
  "all",
  "trace",
  "debug",
  "info",
  "warning",
  "error",
];

function isValidFilterLevel(value: unknown): value is FilterLevel {
  return typeof value === "string" && VALID_FILTER_LEVELS.includes(value as FilterLevel);
}

function isValidCategory(value: unknown): value is LogCategory {
  return typeof value === "string" && ALL_CATEGORIES.includes(value as LogCategory);
}

function loadFromStorage(): Partial<FilterState> | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

    const result: Partial<FilterState> = {};

    if (isValidFilterLevel(parsed.filterLevel)) {
      result.filterLevel = parsed.filterLevel;
    }

    if (Array.isArray(parsed.selectedCategories)) {
      result.selectedCategories = parsed.selectedCategories.filter(isValidCategory);
    }

    if (typeof parsed.textFilter === "string") {
      result.textFilter = parsed.textFilter;
    }

    return result;
  } catch {
    return null;
  }
}

function loadFromUrlParams(): Partial<FilterState> | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const result: Partial<FilterState> = {};
    let hasParams = false;

    const level = params.get("level");
    if (level && isValidFilterLevel(level)) {
      result.filterLevel = level;
      hasParams = true;
    }

    const category = params.get("category");
    if (category) {
      const categories = category.split(",").filter(isValidCategory);
      if (categories.length > 0) {
        result.selectedCategories = categories;
        hasParams = true;
      }
    }

    const q = params.get("q");
    if (q) {
      result.textFilter = q;
      hasParams = true;
    }

    return hasParams ? result : null;
  } catch {
    return null;
  }
}

function saveToStorage(state: FilterState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

export function usePersistentFilter() {
  // URL params take priority over localStorage
  const urlState = useRef(loadFromUrlParams());
  const storageState = useRef(urlState.current ? null : loadFromStorage());
  const initialState = urlState.current ?? storageState.current;

  const [filterLevel, setFilterLevel] = useState<FilterLevel>(
    initialState?.filterLevel ?? "all",
  );
  const [selectedCategories, setSelectedCategories] = useState<LogCategory[]>(
    initialState?.selectedCategories ?? [],
  );
  const [textFilter, setTextFilter] = useState(
    initialState?.textFilter ?? "",
  );

  // Save to localStorage on change (skip initial render)
  const isInitialRender = useRef(true);
  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false;
      return;
    }
    saveToStorage({ filterLevel, selectedCategories, textFilter });
  }, [filterLevel, selectedCategories, textFilter]);

  const toggleCategory = useCallback((category: LogCategory) => {
    setSelectedCategories((prev) =>
      prev.includes(category)
        ? prev.filter((c) => c !== category)
        : [...prev, category],
    );
  }, []);

  const clearCategories = useCallback(() => {
    setSelectedCategories([]);
  }, []);

  return {
    filterLevel,
    setFilterLevel,
    selectedCategories,
    setSelectedCategories,
    textFilter,
    setTextFilter,
    toggleCategory,
    clearCategories,
  };
}

// Exported for testing
export { loadFromStorage, loadFromUrlParams, saveToStorage, isValidCategory, isValidFilterLevel, STORAGE_KEY };
