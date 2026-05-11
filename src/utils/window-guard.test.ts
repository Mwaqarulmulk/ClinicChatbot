import { describe, expect, test } from "bun:test";
import { TtlSet, WindowGuard } from "./window-guard";

describe("WindowGuard", () => {
  test("allows first request within limit", () => {
    const guard = new WindowGuard(5, 60_000);
    expect(guard.allow("user1")).toBe(true);
  });

  test("allows multiple requests up to limit", () => {
    const guard = new WindowGuard(3, 60_000);
    expect(guard.allow("user1")).toBe(true);
    expect(guard.allow("user1")).toBe(true);
    expect(guard.allow("user1")).toBe(true);
  });

  test("blocks request exceeding limit", () => {
    const guard = new WindowGuard(3, 60_000);
    guard.allow("user1");
    guard.allow("user1");
    guard.allow("user1");
    expect(guard.allow("user1")).toBe(false);
  });

  test("tracks different keys independently", () => {
    const guard = new WindowGuard(1, 60_000);
    expect(guard.allow("user1")).toBe(true);
    expect(guard.allow("user2")).toBe(true);
    expect(guard.allow("user1")).toBe(false);
  });

  test("resets after window expires", async () => {
    const guard = new WindowGuard(1, 50); // 50 ms window
    expect(guard.allow("user1")).toBe(true);
    expect(guard.allow("user1")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(guard.allow("user1")).toBe(true);
  });
});

describe("TtlSet", () => {
  test("returns false on first add and true on second", () => {
    const set = new TtlSet(60_000);
    expect(set.hasOrAdd("msg1")).toBe(false);
    expect(set.hasOrAdd("msg1")).toBe(true);
  });

  test("tracks different values independently", () => {
    const set = new TtlSet(60_000);
    expect(set.hasOrAdd("a")).toBe(false);
    expect(set.hasOrAdd("b")).toBe(false);
    expect(set.hasOrAdd("a")).toBe(true);
  });

  test("expires entries after TTL", async () => {
    const set = new TtlSet(50); // 50 ms TTL
    set.hasOrAdd("msg1");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(set.hasOrAdd("msg1")).toBe(false);
  });
});
