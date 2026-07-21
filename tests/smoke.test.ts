import { expect, it } from "bun:test";
import { DevToApiError, DevToClient } from "../src/index.ts";

it("exports the package entry", () => {
  expect(DevToClient).toBeTypeOf("function");
  expect(DevToApiError).toBeTypeOf("function");
});
