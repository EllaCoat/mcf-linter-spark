// The game versions that have vanilla data, and how versions compare.

import { parseU32 } from "./numbers.ts";

/** Each release with the misode/mcmeta commit of its `<version>-summary` tag, oldest first. */
export const RELEASES: readonly (readonly [string, string])[] = [
  ["1.20.4", "c85548aae6f200b4cd823bca81528eedfc790de0"],
  ["1.20.5", "c6fead19ac8face862e20e60fecf26f13fbd55ca"],
  ["1.20.6", "d31d1224060bee7b47fdc9a9e2a775b975f31a2d"],
  ["1.21", "6656d328c8de585bf41b0089308d683cbb677949"],
  ["1.21.1", "7cffbcdad5fa36f22acef6bd4b869ecad4ca3fd9"],
  ["1.21.2", "01ecf4cabccc4291c908b60ca3a0d273df7238f5"],
  ["1.21.3", "755ead9eacd01fe65482951b9866f4b59e23c183"],
  ["1.21.4", "1b221f1ccc1c12b6f995496eab448ba56d397f0d"],
  ["1.21.5", "fae7861a8cb1a84b7f382b570a7fad594ab2b9d1"],
  ["1.21.6", "b88c9f4a991474f58c8aa324831acc527ddaaa3a"],
  ["1.21.7", "9b3aa44515c0ad9d7db7481e04c8709f64683f59"],
  ["1.21.8", "eb65724be139c7a80f5074725537f76c27633d44"],
  ["1.21.9", "e85a17c2e574c2103b0f28da9c02219a81b53297"],
  ["1.21.10", "cb195b930dd0f9c61b6858107aaa164e19e1d323"],
  ["1.21.11", "c976eb3b2cfcb9f205171527dec46b266afa3ac9"],
  ["26.1", "e7068326fb23dcdff9fff17c7eabcd59f46e7460"],
  ["26.1.1", "9ffdce1f63287433ff96f27a11d5d58599d2e0b3"],
  ["26.1.2", "805b8ac25af336a444125f325c33b768af0c8bb3"],
  ["26.2", "711a353b47d84e6cb592a1b72f682e5f44759284"],
  ["26.3", "d96c75fec200c4580dd75e033a76341521165461"],
];

/** The index in `RELEASES` of the data a game version uses. 1.20.3 shares the 1.20.4 data:
 * the two versions have the same commands. */
export function releaseIndex(version: string): number | undefined {
  const v = version === "1.20.3" ? "1.20.4" : version;
  const i = RELEASES.findIndex(([r]) => r === v);
  return i < 0 ? undefined : i;
}

/** `1.21.5` as `[1, 21, 5]`; a part that is not a number counts as 0. */
export function parse(v: string): number[] {
  return v.split(".").map((p) => parseU32(p) ?? 0);
}

/** Compares release versions part by part, a missing part counting as 0. Negative, 0, or positive. */
export function cmp(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
