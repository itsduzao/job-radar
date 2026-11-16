import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.js";

describe("logger", () => {
  it("logs info as JSON with timestamp, level, source, and message", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("test-source");
    logger.info("hello world");
    expect(consoleSpy).toHaveBeenCalledOnce();
    const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(logged.level).toBe("info");
    expect(logged.source).toBe("test-source");
    expect(logged.msg).toBe("hello world");
    expect(logged.ts).toBeDefined();
    consoleSpy.mockRestore();
  });

  it("logs warn as JSON", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("test-source");
    logger.warn("warning message");
    const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(logged.level).toBe("warn");
    consoleSpy.mockRestore();
  });

  it("logs error as JSON", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("test-source");
    logger.error("error message");
    const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(logged.level).toBe("error");
    consoleSpy.mockRestore();
  });

  it("includes extra fields in log output", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("test-source");
    logger.info("with fields", { key: "value", count: 42 });
    const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(logged.key).toBe("value");
    expect(logged.count).toBe(42);
    consoleSpy.mockRestore();
  });

  it("child logger inherits source and adds fields", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("parent");
    const child = logger.child({ component: "child-component", requestId: "abc-123" });
    child.info("child message");
    const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(logged.source).toBe("parent");
    expect(logged.component).toBe("child-component");
    expect(logged.requestId).toBe("abc-123");
    consoleSpy.mockRestore();
  });
});