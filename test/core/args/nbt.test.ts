import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type NbtEntry,
  type NbtNode,
  type NbtPathNode,
  type NbtValue,
  parseCompound,
  parsePath,
  parseTag,
} from "../../../src/core/args/nbt.ts";
import { ParseError } from "../../../src/core/diag.ts";
import { type PResult, Reader } from "../../../src/core/reader.ts";

function unwrap<T>(r: PResult<T>): T {
  if (r instanceof ParseError) assert.fail(r.message);
  return r;
}

function tag(src: string): PResult<NbtNode> {
  return parseTag(new Reader(src, 0), false);
}

function value(src: string): NbtValue {
  const r = tag(src);
  if (r instanceof ParseError) assert.fail(`${src}: ${r.message}`);
  return r.value;
}

function error(src: string): [number, number, string] {
  const e = tag(src);
  assert.ok(e instanceof ParseError, src);
  return [e.start, e.end, e.message];
}

function path(src: string): PResult<NbtPathNode[]> {
  return parsePath(new Reader(src, 0), false);
}

function pathError(src: string): [number, string] {
  const e = path(src);
  assert.ok(e instanceof ParseError, src);
  return [e.start, e.message];
}

function string(v: string, quote: string | undefined): NbtValue {
  return { kind: "String", value: v, quote };
}

function byte(v: number): NbtValue {
  return { kind: "Byte", value: v, rawBool: undefined };
}

function intNode(start: number, end: number, v: number): NbtNode {
  return { start, end, value: { kind: "Int", value: v } };
}

function entriesOf(v: NbtValue): NbtEntry[] {
  if (v.kind !== "Compound") assert.fail(`not a compound: ${v.kind}`);
  return v.entries;
}

function listItems(v: NbtValue): NbtNode[] {
  if (v.kind !== "List") assert.fail(`not a list: ${v.kind}`);
  return v.items;
}

test("compound_with_offsets", () => {
  const r = new Reader(`{a:1b,"b":'x',c:[1,2]} tail`, 100);
  const node = unwrap(parseCompound(r, false));
  assert.equal(r.rest(), " tail");
  assert.deepEqual([node.start, node.end], [100, 122]);
  const entries = entriesOf(node.value);
  assert.equal(entries.length, 3);

  assert.deepEqual([entries[0]!.key, entries[0]!.keyQuote], ["a", undefined]);
  assert.deepEqual([entries[0]!.keyStart, entries[0]!.keyEnd], [101, 102]);
  assert.deepEqual(entries[0]!.value, { start: 103, end: 105, value: byte(1) });

  assert.deepEqual([entries[1]!.key, entries[1]!.keyQuote], ["b", '"']);
  assert.deepEqual([entries[1]!.keyStart, entries[1]!.keyEnd], [106, 109]);
  assert.deepEqual(entries[1]!.value, { start: 110, end: 113, value: string("x", "'") });

  assert.deepEqual([entries[2]!.key, entries[2]!.keyQuote], ["c", undefined]);
  const expected: NbtValue = { kind: "List", items: [intNode(117, 118, 1), intNode(119, 120, 2)] };
  assert.deepEqual(entries[2]!.value, { start: 116, end: 121, value: expected });
});

test("empty_compound_and_nesting", () => {
  assert.deepEqual(value("{}"), { kind: "Compound", entries: [] });
  const outer = entriesOf(value("{a:{b:{}}}"));
  const inner = entriesOf(outer[0]!.value.value);
  assert.equal(inner[0]!.key, "b");
  assert.deepEqual(inner[0]!.value.value, { kind: "Compound", entries: [] });
});

test("whitespace_and_trailing_commas", () => {
  const r = new Reader("  { a : 1 , b : [ 1 , 2 , ] , }  x", 0);
  const node = unwrap(parseCompound(r, false));
  assert.deepEqual([node.start, node.end], [2, 31]);
  assert.equal(r.rest(), "  x");
  const entries = entriesOf(node.value);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0]!.value.value, { kind: "Int", value: 1 });
  assert.equal(listItems(entries[1]!.value.value).length, 2);
  assert.deepEqual(value("\t[\n1,\n2\n]"), { kind: "List", items: [intNode(3, 4, 1), intNode(6, 7, 2)] });
});

test("non_breaking_space_is_not_whitespace", () => {
  // Rust counts UTF-8 bytes: (3, 5) and 6..7. Here U+00A0 and U+3000 are one unit each.
  assert.deepEqual(error("{a:\u{a0}1}"), [3, 4, "Expected value"]);
  assert.deepEqual(value("{a:\u{3000}1}"), {
    kind: "Compound",
    entries: [{ key: "a", keyQuote: undefined, keyStart: 1, keyEnd: 2, value: intNode(4, 5, 1) }],
  });
});

test("number_types_and_suffixes", () => {
  const cases: [string, NbtValue][] = [
    ["1b", byte(1)],
    ["-1B", byte(-1)],
    ["+7b", byte(7)],
    ["127b", byte(127)],
    ["1s", { kind: "Short", value: 1 }],
    ["-32768S", { kind: "Short", value: -32768 }],
    ["0", { kind: "Int", value: 0 }],
    ["-0", { kind: "Int", value: 0 }],
    ["-5", { kind: "Int", value: -5 }],
    ["+5", { kind: "Int", value: 5 }],
    ["2147483647", { kind: "Int", value: 2147483647 }],
    ["1l", { kind: "Long", value: 1n }],
    ["-9223372036854775808L", { kind: "Long", value: -9223372036854775808n }],
    ["1.5", { kind: "Double", value: 1.5 }],
    [".5", { kind: "Double", value: 0.5 }],
    ["5.", { kind: "Double", value: 5.0 }],
    ["-1.5e2", { kind: "Double", value: -150.0 }],
    ["1.5E-1", { kind: "Double", value: 0.15 }],
    ["1.e2", { kind: "Double", value: 100.0 }],
    ["1d", { kind: "Double", value: 1.0 }],
    ["1D", { kind: "Double", value: 1.0 }],
    ["1.d", { kind: "Double", value: 1.0 }],
    [".5d", { kind: "Double", value: 0.5 }],
    ["1e5d", { kind: "Double", value: 100000.0 }],
    ["1f", { kind: "Float", value: 1.0 }],
    ["1.5F", { kind: "Float", value: 1.5 }],
    ["-.5f", { kind: "Float", value: -0.5 }],
    ["1e5f", { kind: "Float", value: 100000.0 }],
    ["1e999f", { kind: "Float", value: Infinity }],
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(value(text), expected, text);
  }
});

test("number_looking_text_is_a_string", () => {
  for (const text of [
    "128b", "-129b", "32768s", "2147483648", "9223372036854775808l", "01", "00b", "007", "1e5", "1e", "e5", "1.5b",
    "1.5l", "1.5s", "1.5.5", "1.5.5f", "-", "+", ".", "-.", ".f", "f", "b", "1-2", "--1", "+-1", "1_000", "1e+f",
    "1e5.5", "abc", "1x", "0x10", "NaN", "Infinity", "truee", "1ff",
  ]) {
    assert.deepEqual(value(text), string(text, undefined), text);
  }
});

test("true_and_false_are_bytes", () => {
  const boolByte = (v: number, raw: boolean): NbtValue => ({ kind: "Byte", value: v, rawBool: raw });
  assert.deepEqual(value("true"), boolByte(1, true));
  assert.deepEqual(value("false"), boolByte(0, false));
  assert.deepEqual(value("TRUE"), boolByte(1, true));
  assert.deepEqual(value("False"), boolByte(0, false));
  assert.deepEqual(value("1b"), { kind: "Byte", value: 1, rawBool: undefined });
  assert.deepEqual(value('"true"'), string("true", '"'));
  assert.deepEqual(value("tru"), string("tru", undefined));
});

test("quoted_strings", () => {
  assert.deepEqual(value(String.raw`"a\"b\\c"`), string(String.raw`a"b\c`, '"'));
  assert.deepEqual(value(String.raw`'a"b'`), string('a"b', "'"));
  assert.deepEqual(value(String.raw`'it\'s'`), string("it's", "'"));
  assert.deepEqual(value(String.raw`"1b"`), string("1b", '"'));
  assert.deepEqual(value(String.raw`""`), string("", '"'));
});

test("unquoted_value_stops_at_disallowed_characters", () => {
  let r = new Reader("foo:bar", 0);
  const node = unwrap(parseTag(r, false));
  assert.deepEqual(node.value, string("foo", undefined));
  assert.equal(r.rest(), ":bar");

  r = new Reader("12 rest", 0);
  assert.deepEqual(unwrap(parseTag(r, false)).value, { kind: "Int", value: 12 });
  assert.equal(r.rest(), " rest");
});

test("quoted_keys_and_escapes_in_keys", () => {
  const entries = entriesOf(value(String.raw`{"a b":1,'c\'d':2,1.5:3,-x:4}`));
  const keys = entries.map((e) => [e.key, e.keyQuote]);
  assert.deepEqual(keys, [["a b", '"'], ["c'd", "'"], ["1.5", undefined], ["-x", undefined]]);
  assert.deepEqual([entries[0]!.keyStart, entries[0]!.keyEnd], [1, 6]);
});

test("duplicate_keys_are_kept", () => {
  assert.equal(entriesOf(value("{a:1,a:2}")).length, 2);
});

test("lists", () => {
  assert.deepEqual(value("[]"), { kind: "List", items: [] });
  assert.deepEqual(value("[ ]"), { kind: "List", items: [] });
  assert.deepEqual(value("[1,2,3]"), { kind: "List", items: [intNode(1, 2, 1), intNode(3, 4, 2), intNode(5, 6, 3)] });
  assert.equal(listItems(value("[true,1b,false]")).length, 3);
  assert.equal(listItems(value("[[1],['a']]")).length, 2);
  assert.equal(listItems(value("[{a:1},{b:'x'}]")).length, 2);
  assert.equal(listItems(value("[ 'a' , \"b\" , c ]")).length, 3);
  // the array form needs `;` right after the type character
  assert.deepEqual(error("[ B;1]"), [3, 4, "Expected ']'"]);
});

test("mixed_list_is_an_error", () => {
  assert.deepEqual(error("[1,2L]"), [3, 5, "Can't insert TAG_Long into list of TAG_Int"]);
  assert.deepEqual(error("[1, 1.0]"), [4, 7, "Can't insert TAG_Double into list of TAG_Int"]);
  assert.equal(error("[1b,1]")[2], "Can't insert TAG_Int into list of TAG_Byte");
  assert.equal(error("['a',1]")[2], "Can't insert TAG_Int into list of TAG_String");
  assert.equal(error("[{},[]]")[2], "Can't insert TAG_List into list of TAG_Compound");
  assert.equal(error("[a,1b,2]")[2], "Can't insert TAG_Byte into list of TAG_String");
});

test("typed_arrays", () => {
  assert.deepEqual(value("[B;1b,true]"), {
    kind: "ByteArray",
    items: [
      { start: 3, end: 5, value: byte(1) },
      { start: 6, end: 10, value: { kind: "Byte", value: 1, rawBool: true } },
    ],
  });
  assert.deepEqual(value("[I;1,-2]"), { kind: "IntArray", items: [intNode(3, 4, 1), intNode(5, 7, -2)] });
  assert.deepEqual(value("[L; 1L , 2l ]"), {
    kind: "LongArray",
    items: [
      { start: 4, end: 6, value: { kind: "Long", value: 1n } },
      { start: 9, end: 11, value: { kind: "Long", value: 2n } },
    ],
  });
  assert.deepEqual(value("[B;]"), { kind: "ByteArray", items: [] });
  assert.deepEqual(value("[I;]"), { kind: "IntArray", items: [] });
  assert.deepEqual(value("[L;1l,]"), {
    kind: "LongArray",
    items: [{ start: 3, end: 5, value: { kind: "Long", value: 1n } }],
  });
  const node = unwrap(tag("[I;1,2]"));
  assert.deepEqual([node.start, node.end], [0, 7]);
});

test("typed_array_errors", () => {
  assert.deepEqual(error("[B;1]"), [3, 4, "Can't insert TAG_Int into TAG_Byte_Array"]);
  assert.equal(error("[I;1b]")[2], "Can't insert TAG_Byte into TAG_Int_Array");
  assert.equal(error("[L;1]")[2], "Can't insert TAG_Int into TAG_Long_Array");
  assert.equal(error('[I;"a"]')[2], "Can't insert TAG_String into TAG_Int_Array");
  assert.equal(error("[I;[1]]")[2], "Can't insert TAG_List into TAG_Int_Array");
  assert.deepEqual(error("[X;1]"), [1, 2, "Invalid array type 'X'"]);
  assert.equal(error("[b;1b]")[2], "Invalid array type 'b'");
  assert.equal(error("[X;")[2], "Expected value");
  assert.equal(error("[I;1 2]")[2], "Expected ']'");
});

test("quoted_second_character_makes_a_list", () => {
  assert.deepEqual(error("[a;]"), [1, 2, "Invalid array type 'a'"]);
  assert.deepEqual(error('["a";]'), [4, 5, "Expected ']'"]);
});

test("syntax_errors", () => {
  assert.deepEqual(error(""), [0, 0, "Expected value"]);
  assert.deepEqual(error("  "), [2, 2, "Expected value"]);
  assert.deepEqual(error("@s"), [0, 1, "Expected value"]);
  assert.deepEqual(error("{a:}"), [3, 4, "Expected value"]);
  assert.equal(error("{a:@}")[2], "Expected value");
  assert.deepEqual(error("{:1}"), [1, 2, "Expected key"]);
  assert.equal(error('{"":1}')[2], "Expected key");
  assert.equal(error("{a:1,")[2], "Expected key");
  assert.equal(error("{a:1,b")[2], "Expected ':'");
  assert.deepEqual(error("{a 1}"), [3, 4, "Expected ':'"]);
  assert.deepEqual(error("{a:1 b:2}"), [5, 6, "Expected '}'"]);
  assert.deepEqual(error("{a:1"), [4, 4, "Expected '}'"]);
  assert.deepEqual(error("{"), [1, 1, "Expected '}'"]);
  assert.equal(error("[1,")[2], "Expected value");
  assert.equal(error("[")[2], "Expected value");
  assert.deepEqual(error("[1 2]"), [3, 4, "Expected ']'"]);
  assert.equal(error("[1")[2], "Expected ']'");
  assert.equal(error("{a:1]")[2], "Expected '}'");
  assert.equal(error("{a:[1}")[2], "Expected ']'");
  assert.equal(error('{"a:1}')[2], "Unclosed quoted string");
  assert.equal(error('{a:"x\\n"}')[2], "Invalid escape sequence 'n' in quoted string");
});

test("compound_must_start_with_brace", () => {
  const e = parseCompound(new Reader("[1]", 0), false);
  assert.ok(e instanceof ParseError);
  assert.deepEqual([e.start, e.message], [0, "Expected '{'"]);
  assert.ok(!(parseCompound(new Reader(" {a:1}", 0), false) instanceof ParseError));
});

function key(name: string, quote: string | undefined, start: number, end: number): NbtPathNode {
  return { kind: "Key", name, quote, start, end, filter: undefined };
}

test("path_keys_and_indexes", () => {
  assert.deepEqual(unwrap(path("foo.bar[0].baz[-1]")), [
    key("foo", undefined, 0, 3),
    key("bar", undefined, 4, 7),
    { kind: "Index", index: 0, start: 7, end: 10 },
    key("baz", undefined, 11, 14),
    { kind: "Index", index: -1, start: 14, end: 18 },
  ]);
  assert.deepEqual(unwrap(path("[]")), [{ kind: "AllElements", start: 0, end: 2 }]);
  assert.equal(unwrap(path("a[][1]")).length, 3);
  assert.equal(unwrap(path("[0][1]")).length, 2);
  assert.deepEqual(unwrap(path(`'x y'."z"`)), [key("x y", "'", 0, 5), key("z", '"', 6, 9)]);
  assert.deepEqual(unwrap(path("minecraft:foo.a-b+c@d")), [
    key("minecraft:foo", undefined, 0, 13),
    key("a-b+c@d", undefined, 14, 21),
  ]);
  assert.deepEqual(unwrap(path("")), []);
});

test("path_filters", () => {
  let nodes = unwrap(path("{a:1}.foo"));
  assert.equal(nodes.length, 2);
  const root = nodes[0]!;
  assert.ok(root.kind === "MatchRoot" && root.node.start === 0 && root.node.end === 5);
  assert.deepEqual(nodes[1], key("foo", undefined, 6, 9));

  nodes = unwrap(path("foo{a:1}.bar"));
  const first = nodes[0]!;
  assert.ok(first.kind === "Key");
  assert.deepEqual([first.name, first.start, first.end], ["foo", 0, 3]);
  assert.deepEqual(first.filter === undefined ? undefined : [first.filter.start, first.filter.end], [3, 8]);
  assert.deepEqual(nodes[1], key("bar", undefined, 9, 12));

  nodes = unwrap(path(`Items[{id:"a",Count:1b}].tag`));
  assert.equal(nodes.length, 3);
  const element = nodes[1]!;
  assert.ok(element.kind === "MatchElement" && element.node.start === 6 && element.node.end === 23);

  nodes = unwrap(path(`"a"{b:1}`));
  const quoted = nodes[0]!;
  assert.ok(quoted.kind === "Key" && quoted.quote === '"' && quoted.filter !== undefined);

  nodes = unwrap(path("{a:1}[0]"));
  assert.equal(nodes.length, 2);

  nodes = unwrap(path("a{x: 1, y: [1, 2]}.b"));
  assert.equal(nodes.length, 2);
});

test("path_stops_at_a_space", () => {
  const r = new Reader("foo.bar rest", 0);
  assert.equal(unwrap(parsePath(r, false)).length, 2);
  assert.equal(r.rest(), " rest");
  // vanilla accepts a trailing dot
  assert.deepEqual(unwrap(path("foo.")), [key("foo", undefined, 0, 3)]);
});

test("path_errors", () => {
  assert.deepEqual(pathError("foo..bar"), [4, "Invalid NBT path element"]);
  assert.deepEqual(pathError("foo.]"), [4, "Invalid NBT path element"]);
  assert.deepEqual(pathError("foo.{a:1}"), [4, "Invalid NBT path element"]);
  assert.deepEqual(pathError("foo{a:1}{b:2}"), [8, "Invalid NBT path element"]);
  assert.deepEqual(pathError("[0]{a:1}"), [3, "Invalid NBT path element"]);
  assert.deepEqual(pathError("}"), [0, "Invalid NBT path element"]);
  assert.deepEqual(pathError("foo]"), [3, "Expected '.'"]);
  assert.deepEqual(pathError("{a:1}foo"), [5, "Expected '.'"]);
  assert.deepEqual(pathError(`"a"b`), [3, "Expected '.'"]);
  assert.equal(pathError("foo[")[1], "Expected integer");
  assert.deepEqual(pathError("foo[x]"), [4, "Expected integer"]);
  assert.equal(pathError("foo[ 0]")[1], "Expected integer");
  assert.equal(pathError("foo[1")[1], "Expected ']'");
  assert.equal(pathError("foo[1.5]")[1], "Invalid integer '1.5'");
  assert.equal(pathError("foo[99999999999]")[1], "Invalid integer '99999999999'");
  assert.deepEqual(pathError("foo[{a:1} ]"), [9, "Expected ']'"]);
  assert.equal(pathError("foo[{a:1}")[1], "Expected ']'");
  assert.equal(pathError("foo{a:")[1], "Expected value");
  assert.equal(pathError(`"foo`)[1], "Unclosed quoted string");
});
