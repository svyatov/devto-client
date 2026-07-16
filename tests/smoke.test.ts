import { expect, it } from "vitest";
import { VERSION } from "../src/index.ts";

it("exports the package entry", () => {
  expect(VERSION).toBe("0.1.0");
});
