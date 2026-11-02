// Coordinates: `WorldCoordinates`, `LocalCoordinates`, and their 2D forms.

import { ParseError } from "../diag.ts";
import type { PResult, Reader } from "../reader.ts";

type Num = "Int" | "Double";

/** One world coordinate: `~`, `~1.5`, `5`, `-2.5`. */
function worldCoordinate(r: Reader, num: Num): PResult<void> {
  if (r.peek() === "^") return r.error("Cannot mix world & local coordinates (everything must either use ^ or not)");
  if (!r.canRead()) return r.error("Expected a coordinate");
  const relative = r.tryConsume("~");
  if (relative) {
    if (r.canRead() && r.peek() !== " ") {
      const v = r.readDouble();
      if (v instanceof ParseError) return v;
    }
  } else {
    const v = num === "Int" ? r.readInt() : r.readDouble();
    if (v instanceof ParseError) return v;
  }
}

function localCoordinate(r: Reader): PResult<void> {
  if (!r.tryConsume("^")) return r.error("Cannot mix world & local coordinates (everything must either use ^ or not)");
  if (r.canRead() && r.peek() !== " ") {
    const v = r.readDouble();
    if (v instanceof ParseError) return v;
  }
}

function separator(r: Reader, expected: string): PResult<void> {
  if (r.peek() === " ") {
    r.pos += 1;
    return;
  }
  return r.error(`Incomplete (expected ${expected})`);
}

function coordinates(r: Reader, count: number, num: Num, allowLocal: boolean): PResult<void> {
  const expected = count === 3 ? "3 coordinates" : "2 coordinates";
  if (allowLocal && r.peek() === "^") {
    for (let i = 0; i < count; i++) {
      if (i > 0) {
        const s = separator(r, expected);
        if (s instanceof ParseError) return s;
      }
      const c = localCoordinate(r);
      if (c instanceof ParseError) return c;
    }
    return;
  }
  for (let i = 0; i < count; i++) {
    if (i > 0) {
      const s = separator(r, expected);
      if (s instanceof ParseError) return s;
    }
    const c = worldCoordinate(r, num);
    if (c instanceof ParseError) return c;
  }
}

export function blockPos(r: Reader): PResult<void> {
  return coordinates(r, 3, "Int", true);
}

export function vec3(r: Reader): PResult<void> {
  return coordinates(r, 3, "Double", true);
}

export function columnPos(r: Reader): PResult<void> {
  return coordinates(r, 2, "Int", false);
}

export function vec2(r: Reader): PResult<void> {
  return coordinates(r, 2, "Double", false);
}

export function rotation(r: Reader): PResult<void> {
  return coordinates(r, 2, "Double", false);
}

export function angle(r: Reader): PResult<void> {
  if (!r.canRead()) return r.error("Incomplete (expected 1 angle)");
  r.tryConsume("~");
  if (r.canRead() && r.peek() !== " ") {
    const v = r.readFloat();
    if (v instanceof ParseError) return v;
  }
}
