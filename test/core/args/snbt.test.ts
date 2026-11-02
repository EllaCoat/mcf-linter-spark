import assert from "node:assert/strict";
import { test } from "node:test";

import type { NbtValue } from "../../../src/core/args/nbt.ts";
import { parseCompound, parseTag } from "../../../src/core/args/snbt.ts";
import { debugStr } from "../../../src/core/chars.ts";
import { ParseError } from "../../../src/core/diag.ts";
import { Reader } from "../../../src/core/reader.ts";

function value(src: string): NbtValue {
  const r = parseTag(new Reader(src, 0));
  if (r instanceof ParseError) assert.fail(`${src}: ${r.message}`);
  return r.value;
}

/** A value in the form the expected strings of these tests use; kinds other than strings print their name. */
function debugValue(v: NbtValue): string {
  if (v.kind !== "String") return v.kind;
  const quote = v.quote === undefined ? "None" : `Some(${v.quote.charCodeAt(0)})`;
  return `String { value: ${debugStr(v.value)}, quote: ${quote} }`;
}

function error(src: string): string {
  const r = parseTag(new Reader(src, 0));
  return r instanceof ParseError ? r.message : `parsed: ${debugValue(r.value)}`;
}

function byte(v: number): NbtValue {
  return { kind: "Byte", value: v, rawBool: undefined };
}

test("integers_with_radix_sign_and_suffix", () => {
  assert.deepEqual(value("12"), { kind: "Int", value: 12 });
  assert.deepEqual(value("-12"), { kind: "Int", value: -12 });
  assert.deepEqual(value("+12"), { kind: "Int", value: 12 });
  assert.deepEqual(value("1b"), byte(1));
  assert.deepEqual(value("1B"), byte(1));
  assert.deepEqual(value("240ub"), byte(-16));
  assert.deepEqual(value("-5sb"), byte(-5));
  assert.deepEqual(value("1s"), { kind: "Short", value: 1 });
  assert.deepEqual(value("1i"), { kind: "Int", value: 1 });
  assert.deepEqual(value("1l"), { kind: "Long", value: 1n });
  assert.deepEqual(value("0"), { kind: "Int", value: 0 });
  assert.deepEqual(value("0b"), byte(0));
  assert.deepEqual(value("0x1b"), { kind: "Int", value: 27 });
  assert.deepEqual(value("0xFFub"), byte(-1));
  assert.deepEqual(value("0xFFFFFFFF"), { kind: "Int", value: -1 });
  assert.deepEqual(value("0b101"), { kind: "Int", value: 5 });
  assert.deepEqual(value("1_000"), { kind: "Int", value: 1000 });
  assert.deepEqual(value("2147483647"), { kind: "Int", value: 2147483647 });
  assert.deepEqual(value("-2147483648"), { kind: "Int", value: -2147483648 });
});

test("integer_errors", () => {
  assert.ok(error("300b").startsWith("Failed to parse number"));
  assert.ok(error("2147483648").startsWith("Failed to parse number"));
  assert.deepEqual(value("-2147483648"), { kind: "Int", value: -2147483648 });
  assert.ok(error("-170141183460469231731687303715884105728").startsWith("Failed to parse number"));
  assert.ok(error("-0x80000000000000000000000000000000sl").startsWith("Failed to parse number"));
  assert.equal(error("007"), "Decimal numbers can't start with 0");
  assert.equal(error("1abc"), "Unquoted strings can't start with digits 0-9, + or -");
  assert.equal(error("-abc"), "Unquoted strings can't start with digits 0-9, + or -");
  assert.equal(error("-1ub"), "Expected a non-negative number");
  assert.equal(error("-0x1"), "Expected a non-negative number");
  assert.equal(error("_1"), 'parsed: String { value: "_1", quote: None }');
  assert.equal(error("1_"), "Underscore characters are not allowed at the start or end of a number");
  assert.equal(error("0x"), "Expected a hexadecimal number");
});

test("floats", () => {
  assert.deepEqual(value("1.5"), { kind: "Double", value: 1.5 });
  assert.deepEqual(value("1."), { kind: "Double", value: 1.0 });
  assert.deepEqual(value(".5"), { kind: "Double", value: 0.5 });
  assert.deepEqual(value("1e5"), { kind: "Double", value: 1e5 });
  assert.deepEqual(value("1.5e-3f"), { kind: "Float", value: Math.fround(1.5e-3) });
  assert.deepEqual(value("1f"), { kind: "Float", value: 1.0 });
  assert.deepEqual(value("1D"), { kind: "Double", value: 1.0 });
  assert.deepEqual(value("007f"), { kind: "Float", value: 7.0 });
  assert.deepEqual(value("-0.5d"), { kind: "Double", value: -0.5 });
  assert.equal(error("1e400"), "Non-finite numbers are not allowed");
  assert.equal(error("1e40f"), "Non-finite numbers are not allowed");
  assert.equal(error("."), "Unquoted strings can't start with digits 0-9, + or -");
  assert.equal(error("1.5b"), "Unquoted strings can't start with digits 0-9, + or -");
});

test("strings_and_booleans", () => {
  assert.deepEqual(value("abc"), { kind: "String", value: "abc", quote: undefined });
  assert.deepEqual(value("a.b-c+d_e"), { kind: "String", value: "a.b-c+d_e", quote: undefined });
  assert.deepEqual(value("TRUE"), { kind: "Byte", value: 1, rawBool: true });
  assert.deepEqual(value("false"), { kind: "Byte", value: 0, rawBool: false });
  assert.deepEqual(value("'it''"), { kind: "String", value: "it", quote: "'" });
  assert.deepEqual(value(String.raw`"a\tb\x41é\U0001F600\s"`), { kind: "String", value: "a\tbAé\u{1F600} ", quote: '"' });
  assert.equal(error(String.raw`"\q"`), "Invalid string contents");
  assert.equal(error(String.raw`"\x4"`), "Expected a character literal of length 2");
  assert.equal(error(String.raw`"\uD800"`), "Invalid Unicode character value: D800");
  assert.equal(error('"abc'), "Unclosed quoted string");
  assert.equal(error("§"), "Expected value");
});

test("compounds_and_lists", () => {
  const compound = value("{a: 1, 'b c': [1, \"x\", {}], 1d: 2,}");
  assert.ok(compound.kind === "Compound");
  assert.deepEqual(
    compound.entries.map((e) => e.key),
    ["a", "b c", "1d"],
  );
  const list = compound.entries[1]!.value.value;
  assert.ok(list.kind === "List");
  assert.equal(list.items.length, 3);
  assert.deepEqual(value("[]"), { kind: "List", items: [] });
  assert.deepEqual(value("[1,]"), { kind: "List", items: [{ start: 1, end: 2, value: { kind: "Int", value: 1 } }] });
  assert.equal(error("{'': 1}"), "Key cannot be empty");
  assert.equal(error("{a 1}"), "Expected ':'");
  assert.equal(error("{a: 1"), "Expected '}'");
  assert.equal(error("[1 2]"), "Expected ']'");
});

test("arrays", () => {
  const elements = (v: NbtValue): NbtValue[] => {
    if (v.kind !== "ByteArray" && v.kind !== "IntArray" && v.kind !== "LongArray") assert.fail(v.kind);
    return v.items.map((n) => n.value);
  };
  assert.deepEqual(elements(value("[B; 1, 2b]")), [byte(1), byte(2)]);
  assert.deepEqual(elements(value("[I;1b,2s,3]")), [
    { kind: "Int", value: 1 },
    { kind: "Int", value: 2 },
    { kind: "Int", value: 3 },
  ]);
  assert.deepEqual(elements(value("[L;1,2i]")), [
    { kind: "Long", value: 1n },
    { kind: "Long", value: 2n },
  ]);
  assert.deepEqual(elements(value("[B;]")), []);
  assert.deepEqual(elements(value("[ I ; 1 ]")), [{ kind: "Int", value: 1 }]);
  assert.equal(value("[ I ]").kind, "List");
  assert.equal(error("[B;1s]"), "Invalid array element type");
  assert.equal(error("[I;1l]"), "Invalid array element type");
  assert.equal(error("[I;1.5]"), "Invalid array element type");
  assert.equal(error("[I;a]"), "Invalid array element type");
  assert.ok(error("[B;300]").startsWith("Failed to parse number"));
  assert.equal(error("[b;1]"), "Expected ']'");
});

test("operations", () => {
  assert.deepEqual(value("bool(1)"), byte(1));
  assert.deepEqual(value("bool(0.0)"), byte(0));
  assert.deepEqual(value("bool(true)"), byte(1));
  assert.equal(error("bool('a')"), "Expected a number or a boolean");
  const uuid = value('uuid("f81d4fae-7dec-11d0-a765-00a0c91e6bf6")');
  assert.ok(uuid.kind === "IntArray");
  assert.deepEqual(
    uuid.items.map((n) => n.value),
    [-132296786, 2112623056, -1486552928, -920753162].map((v) => ({ kind: "Int", value: v })),
  );
  assert.equal(error("uuid('x')"), "Expected a string representing a valid UUID");
  assert.equal(error("foo(1)"), "No such operation: foo/1");
  assert.equal(error("Bool(1)"), "No such operation: Bool/1");
});

test("compound_argument", () => {
  assert.ok(!(parseCompound(new Reader(" {a:1}", 0)) instanceof ParseError));
  const e = parseCompound(new Reader("[1]", 0));
  assert.ok(e instanceof ParseError);
  assert.equal(e.message, "Expected compound tag");
});
