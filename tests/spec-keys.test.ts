import { describe, expect, it } from "bun:test";
import {
  declaredKeys,
  extraKeys,
  isShapeMismatch,
  isVacuous,
  missingKeys,
  type Schema,
  successSchema,
} from "../scripts/spec-keys.ts";

describe("declaredKeys", () => {
  it("flattens an allOf composition into the union of its members' properties", () => {
    const schema: Schema = {
      allOf: [
        { type: "object", properties: { id: {}, title: {} } },
        { type: "object", properties: { body_markdown: {} } },
      ],
    };
    expect(declaredKeys(schema).sort()).toEqual(["body_markdown", "id", "title"]);
  });

  it("resolves a $ref before reading properties", () => {
    expect(declaredKeys({ $ref: "#/components/schemas/ArticleIndex" })).toContain("title");
    expect(() => declaredKeys({ $ref: "#/components/schemas/Nope" })).toThrow(/unresolvable/);
  });
});

describe("missingKeys", () => {
  const arraySchema: Schema = {
    type: "array",
    items: { type: "object", properties: { id: {}, organization: {} } },
  };

  it("unions keys across array elements and reports only keys absent from every element", () => {
    expect(missingKeys([{ id: 1 }, { id: 2, organization: {} }], arraySchema)).toEqual([]);
    expect(missingKeys([{ id: 1 }], arraySchema)).toEqual(["organization"]);
  });

  it("returns the full declared set for an empty object payload", () => {
    const schema: Schema = { type: "object", properties: { id: {}, title: {} } };
    expect(missingKeys({}, schema)).toEqual(["id", "title"]);
  });
});

describe("extraKeys", () => {
  it("reports a payload key the schema does not declare", () => {
    const schema: Schema = { type: "object", properties: { id: {} } };
    expect(extraKeys({ id: 1, subforem_id: 3 }, schema)).toEqual(["subforem_id"]);
  });

  it("returns empty when the payload is a strict subset of the schema", () => {
    const schema: Schema = { type: "object", properties: { id: {}, title: {} } };
    expect(extraKeys({ id: 1 }, schema)).toEqual([]);
  });

  it("unions keys across array elements, so a key on one element only is still reported", () => {
    const schema: Schema = { type: "array", items: { type: "object", properties: { id: {} } } };
    expect(extraKeys([{ id: 1 }, { id: 2, subforem_id: 3 }], schema)).toEqual(["subforem_id"]);
  });

  it("reports a shape mismatch in both directions, symmetrically with missingKeys", () => {
    // extraKeys once lacked the not-an-object guard: a scalar carries no keys, so
    // it returned [] and read as "no drift" when nothing had actually been compared.
    const object: Schema = { type: "object", properties: { id: {} } };
    const array: Schema = { type: "array", items: object };
    for (const keys of [extraKeys, missingKeys]) {
      expect(keys("a string", object)).toEqual(["<payload is not an object>"]);
      expect(keys({ id: 1 }, array)).toEqual(["<payload is not an array>"]);
      // `typeof [] === "object"`, so without an explicit Array.isArray guard this
      // unions the elements' keys and comes back empty, reading as "matched"
      expect(keys([{ id: 1 }], object)).toEqual(["<payload is not an object>"]);
    }
  });

  it("marks the shape sentinel as such and a real key name as not", () => {
    expect(isShapeMismatch("<payload is not an array>")).toBe(true);
    expect(isShapeMismatch("subforem_id")).toBe(false);
  });
});

describe("isVacuous", () => {
  it("is true for an empty array and an empty object, false for a populated one", () => {
    expect(isVacuous([])).toBe(true);
    expect(isVacuous({})).toBe(true);
    expect(isVacuous([{ id: 1 }])).toBe(false);
    expect(isVacuous({ id: 1 })).toBe(false);
  });
});

describe("successSchema", () => {
  it("resolves the success response schema for a template plus method", () => {
    const lookup = successSchema("/api/articles", "get");
    expect(lookup.kind).toBe("schema");
  });

  it("reports absence for a template that declares no success content", () => {
    expect(successSchema("/api/articles/{id}/unpublish", "put").kind).toBe("none");
    expect(successSchema("/api/deleted_upstream", "get")).toEqual({ kind: "removed" });
  });
});
