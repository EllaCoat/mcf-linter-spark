import { charAt, floorCharBoundary } from "./chars.ts";

/** Converts offsets into zero-based lines and columns. Both count UTF-16 code units, as LSP does. */
export class LineIndex {
  private readonly starts: number[];

  constructor(text: string) {
    this.starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
    }
  }

  position(text: string, offset: number): [number, number] {
    const at = floorCharBoundary(text, offset);
    let lo = 0;
    let hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.starts[mid]! <= at) lo = mid + 1;
      else hi = mid;
    }
    const line = lo - 1;
    return [line, at - this.starts[line]!];
  }

  utf16Offset(text: string, offset: number): number {
    return floorCharBoundary(text, offset);
  }

  /** The offset of a zero-based line and column. */
  offset(text: string, line: number, col: number): number {
    const start = this.starts[line];
    if (start === undefined) return text.length;
    let units = 0;
    for (let i = start; i < text.length; ) {
      const c = charAt(text, i)!;
      if (units >= col || c === "\n") return i;
      units += c.length;
      i += c.length;
    }
    return text.length;
  }
}
