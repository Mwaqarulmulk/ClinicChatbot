import { describe, expect, test } from "bun:test";
import { createId } from "./id";

describe("createId", () => {
  test("starts with the provided prefix", () => {
    expect(createId("usr")).toMatch(/^usr_/);
    expect(createId("apt")).toMatch(/^apt_/);
    expect(createId("msg")).toMatch(/^msg_/);
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => createId("x")));
    expect(ids.size).toBe(100);
  });

  test("contains no hyphens in the UUID part", () => {
    const id = createId("test");
    const uuidPart = id.slice("test_".length);
    expect(uuidPart).not.toContain("-");
  });

  test("ID length is prefix + underscore + 32 hex chars", () => {
    const prefix = "pfx";
    const id = createId(prefix);
    expect(id.length).toBe(prefix.length + 1 + 32);
  });
});
