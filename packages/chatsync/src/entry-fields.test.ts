import { describe, expect, it } from "vitest";
import { ACCOUNT_BOUND_FIELDS, hasAccountBound, withoutAccountBound } from "./entry-fields.js";
import { entry } from "./test-helpers.js";

describe("account-bound fields", () => {
  it("lists the six fields", () => {
    expect([...ACCOUNT_BOUND_FIELDS]).toEqual([
      "sshReattach",
      "sshRemoteProcessId",
      "error",
      "errorAt",
      "errorRows",
      "priorErrorMark",
    ]);
  });

  it("withoutAccountBound drops them, keeps everything else, and never mutates", () => {
    const data = {
      ...entry({ id: "s1", at: 5, title: "T" }),
      sshReattach: { a: 1 },
      sshRemoteProcessId: 42,
      error: "quota",
      errorAt: 9,
      errorRows: [1],
      priorErrorMark: 3,
      cwd: "/x",
    };
    const copy = JSON.parse(JSON.stringify(data)) as unknown;
    const out = withoutAccountBound(data);
    expect(out).toEqual({ ...entry({ id: "s1", at: 5, title: "T" }), cwd: "/x" });
    expect(out).not.toBe(data);
    expect(data).toEqual(copy);
  });

  it("hasAccountBound is true for any one of the fields", () => {
    expect(hasAccountBound(entry({ id: "s1", at: 1 }))).toBe(false);
    for (const f of ACCOUNT_BOUND_FIELDS) {
      expect(hasAccountBound({ ...entry({ id: "s1", at: 1 }), [f]: null })).toBe(true);
    }
  });
});
