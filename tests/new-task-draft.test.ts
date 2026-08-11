// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearNewTaskDraft,
  parseNewTaskDraft,
  readNewTaskDraft,
  writeNewTaskDraft,
} from "@/lib/new-task-draft";

const DRAFT_STORAGE_KEY = "new-task-form:draft";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("parseNewTaskDraft", () => {
  it("keeps every recognized, correctly-typed field", () => {
    const input = {
      repoId: "repo_1",
      title: "A title",
      branchName: "feature/x",
      description: "A description",
      priority: "high",
      requireHumanCodeReview: true,
      maxCostPerTaskUsd: "12.5",
    };
    expect(parseNewTaskDraft(input)).toEqual(input);
  });

  it("drops an unrecognized priority value rather than crashing", () => {
    expect(parseNewTaskDraft({ priority: "extreme" })).toEqual({});
  });

  it("drops wrong-typed fields individually, keeping the rest", () => {
    const input = {
      title: 123,
      description: "Kept",
      requireHumanCodeReview: "yes",
      maxCostPerTaskUsd: 12,
    };
    expect(parseNewTaskDraft(input)).toEqual({ description: "Kept" });
  });

  it("drops dependsOn unconditionally, regardless of its shape", () => {
    expect(parseNewTaskDraft({ dependsOn: ["task_a"], title: "x" })).toEqual({ title: "x" });
    expect(parseNewTaskDraft({ dependsOn: "not-an-array", title: "x" })).toEqual({ title: "x" });
    expect(parseNewTaskDraft({ dependsOn: null, title: "x" })).toEqual({ title: "x" });
  });

  it("returns an empty draft for null, arrays, and other non-object input", () => {
    expect(parseNewTaskDraft(null)).toEqual({});
    expect(parseNewTaskDraft(undefined)).toEqual({});
    expect(parseNewTaskDraft("a string")).toEqual({});
    expect(parseNewTaskDraft(42)).toEqual({});
    expect(parseNewTaskDraft([1, 2, 3])).toEqual({});
  });
});

describe("readNewTaskDraft / writeNewTaskDraft", () => {
  it("round-trips a written draft", () => {
    const draft = { repoId: "repo_1", title: "Hello" };
    writeNewTaskDraft(draft);
    expect(readNewTaskDraft()).toEqual(draft);
  });

  it("drops dependsOn from a legacy stored draft written before this field was removed", () => {
    window.localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ repoId: "repo_1", title: "Hello", dependsOn: ["task_a"] }),
    );
    const result = readNewTaskDraft();
    expect(result).toEqual({ repoId: "repo_1", title: "Hello" });
    expect(result).not.toHaveProperty("dependsOn");
  });

  it("writes under a dedicated storage key, not a shared namespace", () => {
    writeNewTaskDraft({ title: "Hello" });
    expect(window.localStorage.getItem(DRAFT_STORAGE_KEY)).not.toBeNull();
  });

  it("returns null when nothing has been stored", () => {
    expect(readNewTaskDraft()).toBeNull();
  });

  it("returns null instead of throwing on malformed JSON", () => {
    window.localStorage.setItem(DRAFT_STORAGE_KEY, "{not valid json");
    expect(readNewTaskDraft()).toBeNull();
  });

  it("drops wrong-typed stored fields rather than crashing", () => {
    window.localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ title: "Kept", priority: 999 }),
    );
    expect(readNewTaskDraft()).toEqual({ title: "Kept" });
  });
});

describe("clearNewTaskDraft", () => {
  it("removes a previously written draft", () => {
    writeNewTaskDraft({ title: "Hello" });
    clearNewTaskDraft();
    expect(readNewTaskDraft()).toBeNull();
    expect(window.localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("is a no-op when nothing was stored", () => {
    expect(() => clearNewTaskDraft()).not.toThrow();
    expect(readNewTaskDraft()).toBeNull();
  });
});
