import assert from "node:assert/strict";
import { test } from "node:test";

import { LineIndex } from "../../src/core/position.ts";

// Offsets count UTF-16 code units here, where the Rust tests counted UTF-8 bytes.

test("counts_utf16_columns", () => {
  const text = "ab\nあいz\n";
  const idx = new LineIndex(text);
  const z = text.indexOf("z");
  assert.deepEqual(idx.position(text, z), [1, 2]);
  assert.equal(idx.offset(text, 1, 2), z);
});

test("an_offset_inside_a_character_does_not_panic", () => {
  const text = "ab\n🙂いz\n";
  const idx = new LineIndex(text);
  assert.deepEqual(idx.position(text, 4), [1, 0]);
  assert.deepEqual(idx.position(text, 100), [2, 0]);
});

test("columns_of_a_long_line_count_the_characters_across_chunks", () => {
  const text = `a\n${"x🙂あ".repeat(400)}`;
  const idx = new LineIndex(text);
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i += text.codePointAt(i)! > 0xffff ? 2 : 1) offsets.push(i);
  offsets.push(text.length);
  for (const offset of offsets) {
    const line = offset >= 2 ? 1 : 0;
    const col = offset - (line === 1 ? 2 : 0);
    assert.deepEqual(idx.position(text, offset), [line, col], String(offset));
    assert.equal(idx.utf16Offset(text, offset), offset, String(offset));
  }
});
