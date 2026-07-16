import { expect, it } from "vitest";
import { DevToApiError, DevToClient } from "../src/index.ts";

it("exports the package entry", () => {
  expect(DevToClient).toBeTypeOf("function");
  expect(DevToApiError).toBeTypeOf("function");
});
