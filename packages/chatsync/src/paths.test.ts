import { describe, expect, it } from "vitest";
import { ChatsyncError } from "./errors.js";
import { appDataDir, chatsyncHome, sessionsDir } from "./paths.js";

describe("paths", () => {
  it("appDataDir on darwin", () => {
    expect(appDataDir({ platform: "darwin", home: "/h", env: {} })).toBe("/h/Library/Application Support/Claude");
  });

  it("appDataDir elsewhere throws exit 2", () => {
    const call = () => appDataDir({ platform: "linux", home: "/h", env: {} });
    expect(call).toThrow(/macOS only/);
    try {
      call();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ChatsyncError);
      expect((err as ChatsyncError).exitCode).toBe(2);
    }
  });

  it("env overrides", () => {
    expect(appDataDir({ platform: "linux", env: { CHATSYNC_APP_DIR: "/x" } })).toBe("/x");
    expect(chatsyncHome({ home: "/h", env: { CHATSYNC_HOME: "/y" } })).toBe("/y");
    expect(chatsyncHome({ home: "/h", env: {} })).toBe("/h/.chatsync");
  });

  it("sessionsDir joins claude-code-sessions", () => {
    expect(sessionsDir("/a")).toBe("/a/claude-code-sessions");
  });

  it("ChatsyncError defaults to exit 1", () => {
    const err = new ChatsyncError("boom");
    expect(err.exitCode).toBe(1);
    expect(err.message).toBe("boom");
    expect(err).toBeInstanceOf(Error);
  });
});
