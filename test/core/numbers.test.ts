import assert from "node:assert/strict";
import { test } from "node:test";

import { utf8Len, charCount, compareStr, debugStr, isWhitespace } from "../../src/core/chars.ts";
import { f64ToI32, f64ToI64, fmtF32, fmtF64, parseF64, parseI32, parseI64 } from "../../src/core/numbers.ts";

test("integers parse like Rust's str::parse", () => {
  assert.equal(parseI32("+5"), 5);
  assert.equal(parseI32("007"), 7);
  assert.equal(parseI32("2147483648"), undefined);
  assert.equal(parseI32("-2147483648"), -2147483648);
  assert.equal(parseI32(""), undefined);
  assert.equal(parseI32("0x10"), undefined);
  assert.equal(parseI64("9223372036854775807"), 9223372036854775807n);
  assert.equal(parseI64("9223372036854775808"), undefined);
});

test("floats parse like Rust's str::parse", () => {
  assert.equal(parseF64("1."), 1);
  assert.equal(parseF64(".5"), 0.5);
  assert.equal(parseF64("-.5"), -0.5);
  assert.equal(parseF64("."), undefined);
  assert.equal(parseF64("1e5"), 100000);
  assert.equal(parseF64("1e"), undefined);
  assert.equal(parseF64("inf"), Infinity);
  assert.equal(parseF64(" 1"), undefined);
});

test("casts saturate like Rust's as", () => {
  assert.equal(f64ToI32(1e10), 2147483647);
  assert.equal(f64ToI32(-1.9), -1);
  assert.equal(f64ToI32(NaN), 0);
  assert.equal(f64ToI64(9223372036854775807), 9223372036854775807n);
  assert.equal(f64ToI64(-1e30), -9223372036854775808n);
});

test("floats format like Rust's Display", () => {
  assert.equal(fmtF64(1), "1");
  assert.equal(fmtF64(0.1), "0.1");
  assert.equal(fmtF64(1e21), "1000000000000000000000");
  assert.equal(fmtF64(1.5e-7), "0.00000015");
  assert.equal(fmtF64(-0), "-0");
  assert.equal(fmtF64(-Infinity), "-inf");
  assert.equal(fmtF32(Math.fround(0.1)), "0.1");
  assert.equal(fmtF32(Math.fround(3.4028234663852886e38)), "340282350000000000000000000000000000000");
  assert.equal(fmtF32(Math.fround(-1.5)), "-1.5");
});

test("strings measure like Rust's str", () => {
  assert.equal(utf8Len("aあ🙂"), 1 + 3 + 4);
  assert.equal(charCount("aあ🙂"), 3);
  assert.ok(compareStr("￿", "🙂") < 0);
  assert.ok(isWhitespace("\u0085"));
  assert.ok(!isWhitespace("﻿"));
  assert.equal(debugStr('a"b\\\n\u0001'), '"a\\"b\\\\\\n\\u{1}"');
});
