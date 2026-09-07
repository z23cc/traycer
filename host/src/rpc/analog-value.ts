import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { z } from "zod";

type ZodDef = {
  readonly type: string;
  readonly innerType: unknown;
  readonly inner: unknown;
  readonly shape: unknown;
  readonly options: unknown;
  readonly left: unknown;
  readonly right: unknown;
  readonly items: unknown;
  readonly entries: unknown;
  readonly values: unknown;
  readonly value: unknown;
  readonly format: unknown;
  readonly keyType: unknown;
  readonly valueType: unknown;
  readonly defaultValue: unknown;
  readonly catchValue: unknown;
  readonly getter: unknown;
  readonly schema: unknown;
};

type ZodBag = {
  readonly exclusiveMinimum: number | undefined;
  readonly exclusiveMaximum: number | undefined;
  readonly minimum: number | undefined;
  readonly maximum: number | undefined;
  readonly format: string | undefined;
  readonly patterns: unknown;
};

type ZodInternal = {
  readonly def: ZodDef;
  readonly bag: ZodBag;
};

/**
 * A schema-valid value for a schema, by filling required fields and taking a
 * union's first arm.
 *
 * The STREAM lane's only user, and deliberately so: a subscriber that gets no
 * frame waits forever, so a lane with nothing real to send needs something
 * shaped like a snapshot. The unary lane used to share this and no longer
 * does - see `unimplemented` in `rpc/handlers.ts` for why filling a schema is
 * the wrong answer to a question with a caller waiting on the truth of it.
 */
export function analogFromSchema(schema: z.ZodType): unknown {
  let generated = analogNode(schema);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const parsed = schema.safeParse(generated);
    if (parsed.success) {
      return parsed.data;
    }
    generated = repairAnalog(
      generated,
      parsed.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
        code: String(issue.code),
      })),
    );
  }
  const internals = readInternal(schema);
  if (internals !== null && internals.def.type === "union") {
    const options = asArray(internals.def.options);
    for (const option of options) {
      const candidate = analogNode(option);
      const unionParsed = schema.safeParse(candidate);
      if (unionParsed.success) {
        return unionParsed.data;
      }
    }
  }
  return generated;
}

function analogNode(schema: unknown): unknown {
  const internals = readInternal(schema);
  if (internals === null) {
    return null;
  }
  const def = internals.def;
  const bag = internals.bag;
  switch (def.type) {
    case "optional":
      return analogNode(def.innerType ?? def.inner);
    case "nullable":
      return null;
    case "default":
    case "prefault": {
      const value = invokeMaybe(def.defaultValue);
      if (value !== undefined) {
        return value;
      }
      return analogNode(def.innerType ?? def.inner);
    }
    case "catch": {
      const value = invokeMaybe(def.catchValue);
      if (value !== undefined) {
        return value;
      }
      return analogNode(def.innerType ?? def.inner);
    }
    case "string":
      return analogString(def, bag);
    case "number":
    case "int":
    case "float":
    case "nan":
      return analogNumber(bag);
    case "bigint":
      return BigInt(0);
    case "boolean":
      return false;
    case "null":
      return null;
    case "undefined":
    case "void":
      return undefined;
    case "any":
    case "unknown":
      return null;
    case "literal":
      if (Array.isArray(def.values) && def.values.length > 0) {
        return def.values[0];
      }
      return def.value;
    case "enum":
      return analogEnum(def);
    case "array":
      return [];
    case "tuple":
      return asArray(def.items).map((item) => analogNode(item));
    case "object":
      return analogObject(def);
    case "record":
    case "map":
      return analogRecord(def);
    case "set":
      return [];
    case "union":
    case "or":
      return analogUnion(schema, def);
    case "intersection":
    case "and": {
      const left = analogNode(def.left);
      const right = analogNode(def.right);
      if (isPlainObject(left) && isPlainObject(right)) {
        return { ...left, ...right };
      }
      return left;
    }
    case "readonly":
    case "pipe":
    case "transform":
    case "brand":
    case "success":
    case "custom":
      return analogNode(def.innerType ?? def.inner ?? def.schema);
    case "lazy": {
      const getter = def.getter;
      if (typeof getter === "function") {
        return analogNode(getter());
      }
      return analogNode(def.innerType ?? def.inner);
    }
    case "date":
      return new Date(0);
    case "promise":
      return analogNode(def.innerType);
    default:
      return analogUnion(schema, def);
  }
}

function analogObject(def: ZodDef): { readonly [key: string]: unknown } {
  const rawShape = typeof def.shape === "function" ? def.shape() : def.shape;
  const out: { [key: string]: unknown } = {};
  if (rawShape === null || typeof rawShape !== "object") {
    return out;
  }
  for (const [key, field] of Object.entries(rawShape)) {
    const fieldInternals = readInternal(field);
    if (fieldInternals !== null && fieldInternals.def.type === "optional") {
      continue;
    }
    out[key] = analogNode(field);
  }
  return out;
}

function analogRecord(def: ZodDef): { readonly [key: string]: unknown } {
  const keys = enumKeys(def.keyType);
  const out: { [key: string]: unknown } = {};
  for (const key of keys) {
    out[key] = analogNode(def.valueType);
  }
  return out;
}

function enumKeys(schema: unknown): readonly string[] {
  const internals = readInternal(schema);
  if (internals === null) {
    return [];
  }
  const entries = internals.def.entries;
  if (
    entries !== null &&
    typeof entries === "object" &&
    !Array.isArray(entries)
  ) {
    return Object.keys(entries);
  }
  if (Array.isArray(internals.def.values)) {
    return internals.def.values.filter((row) => typeof row === "string");
  }
  return [];
}

function repairAnalog(
  value: unknown,
  issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
    readonly code: string;
  }[],
): unknown {
  if (!isPlainObject(value)) {
    return value;
  }
  const next: { [key: string]: unknown } = { ...value };
  for (const issue of issues) {
    if (
      issue.code === "invalid_type" &&
      issue.message.includes("expected record")
    ) {
      setPath(next, issue.path, {});
      continue;
    }
    if (
      issue.message.includes(
        "version must be non-null exactly when status is applied",
      )
    ) {
      if (next.status === "applied") {
        next.version = 0;
      } else {
        next.status = "unavailable";
        next.version = null;
      }
      continue;
    }
    if (
      issue.message.includes("chat` must not be null") ||
      issue.message.includes("chat must not be null")
    ) {
      next.outcome = { status: "missing" };
      continue;
    }
  }
  return next;
}

function setPath(
  target: { [key: string]: unknown },
  path: readonly PropertyKey[],
  leaf: unknown,
): void {
  if (path.length === 0) {
    return;
  }
  let cursor: { [key: string]: unknown } = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = String(path[index]);
    const child = cursor[key];
    if (!isPlainObject(child)) {
      const created: { [key: string]: unknown } = {};
      cursor[key] = created;
      cursor = created;
    } else {
      const copy: { [key: string]: unknown } = { ...child };
      cursor[key] = copy;
      cursor = copy;
    }
  }
  cursor[String(path[path.length - 1])] = leaf;
}

function analogUnion(schema: unknown, def: ZodDef): unknown {
  const options = asArray(def.options);
  for (const option of options) {
    const candidate = analogNode(option);
    const parsed = safeParse(schema, candidate);
    if (parsed !== null) {
      return parsed;
    }
  }
  if (options.length > 0) {
    return analogNode(options[0]);
  }
  return analogObject(def);
}

function safeParse(schema: unknown, value: unknown): unknown | null {
  if (schema === null || typeof schema !== "object") {
    return null;
  }
  if (!("safeParse" in schema) || typeof schema.safeParse !== "function") {
    return null;
  }
  const result: unknown = schema.safeParse(value);
  if (result === null || typeof result !== "object") {
    return null;
  }
  if (Reflect.get(result, "success") === true) {
    return Reflect.get(result, "data");
  }
  return null;
}

function analogString(def: ZodDef, bag: ZodBag): string {
  const format = typeof def.format === "string" ? def.format : bag.format;
  if (format === "uuid") {
    return randomUUID();
  }
  if (format === "datetime" || format === "iso_datetime") {
    return new Date(0).toISOString();
  }
  if (format === "email") {
    return "oss@localhost";
  }
  if (format === "url") {
    return "https://localhost/";
  }
  const patterns = collectPatterns(bag.patterns);
  for (const pattern of patterns) {
    if (pattern.test("/")) {
      const home = homedir();
      return home.length > 0 ? home : "/";
    }
    if (pattern.test("oss")) {
      return "oss";
    }
  }
  if (typeof bag.minimum === "number" && bag.minimum > 3) {
    return "x".repeat(bag.minimum);
  }
  return "oss";
}

function analogNumber(bag: ZodBag): number {
  let value = 0;
  if (typeof bag.exclusiveMinimum === "number") {
    value = bag.exclusiveMinimum + 1;
  } else if (typeof bag.minimum === "number") {
    value = bag.minimum;
  }
  if (
    typeof bag.exclusiveMaximum === "number" &&
    value >= bag.exclusiveMaximum
  ) {
    value = bag.exclusiveMaximum - 1;
  } else if (typeof bag.maximum === "number" && value > bag.maximum) {
    value = bag.maximum;
  }
  return value;
}

function analogEnum(def: ZodDef): unknown {
  if (Array.isArray(def.entries) && def.entries.length > 0) {
    return def.entries[0];
  }
  if (Array.isArray(def.values) && def.values.length > 0) {
    return def.values[0];
  }
  if (def.entries !== null && typeof def.entries === "object") {
    const values = Object.values(def.entries);
    if (values.length > 0) {
      return values[0];
    }
  }
  return "oss";
}

function collectPatterns(patterns: unknown): readonly RegExp[] {
  if (patterns instanceof Set) {
    return [...patterns].filter((row) => row instanceof RegExp);
  }
  if (Array.isArray(patterns)) {
    return patterns.filter((row) => row instanceof RegExp);
  }
  return [];
}

function invokeMaybe(value: unknown): unknown {
  if (typeof value === "function") {
    return value();
  }
  return value;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(
  value: unknown,
): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readInternal(schema: unknown): ZodInternal | null {
  if (schema === null || typeof schema !== "object") {
    return null;
  }
  if (!("_zod" in schema)) {
    return null;
  }
  const packed = Reflect.get(schema, "_zod");
  if (packed === null || typeof packed !== "object") {
    return null;
  }
  const defRaw = Reflect.get(packed, "def");
  if (defRaw === null || typeof defRaw !== "object") {
    return null;
  }
  const bagRaw = Reflect.get(packed, "bag");
  const bagObject = bagRaw !== null && typeof bagRaw === "object" ? bagRaw : {};
  return {
    def: {
      type: readString(defRaw, "type"),
      innerType: Reflect.get(defRaw, "innerType"),
      inner: Reflect.get(defRaw, "inner"),
      shape: Reflect.get(defRaw, "shape"),
      options: Reflect.get(defRaw, "options"),
      left: Reflect.get(defRaw, "left"),
      right: Reflect.get(defRaw, "right"),
      items: Reflect.get(defRaw, "items"),
      entries: Reflect.get(defRaw, "entries"),
      values: Reflect.get(defRaw, "values"),
      value: Reflect.get(defRaw, "value"),
      format: Reflect.get(defRaw, "format"),
      keyType: Reflect.get(defRaw, "keyType"),
      valueType: Reflect.get(defRaw, "valueType"),
      defaultValue: Reflect.get(defRaw, "defaultValue"),
      catchValue: Reflect.get(defRaw, "catchValue"),
      getter: Reflect.get(defRaw, "getter"),
      schema: Reflect.get(defRaw, "schema"),
    },
    bag: {
      exclusiveMinimum: readNumber(bagObject, "exclusiveMinimum"),
      exclusiveMaximum: readNumber(bagObject, "exclusiveMaximum"),
      minimum: readNumber(bagObject, "minimum"),
      maximum: readNumber(bagObject, "maximum"),
      format: optionalString(Reflect.get(bagObject, "format")),
      patterns: Reflect.get(bagObject, "patterns"),
    },
  };
}

function readString(record: object, key: string): string {
  const value = Reflect.get(record, key);
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: object, key: string): number | undefined {
  const value = Reflect.get(record, key);
  return typeof value === "number" ? value : undefined;
}
