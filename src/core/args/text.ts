// JSON text components (`minecraft:component`) and styles (`minecraft:style`). From 1.21.5 both
// are SNBT, checked against the text types of vanilla-mcdoc instead.
//
// 1.20.4 reads one value with Gson's strict `JsonReader` (`ParserUtils.parseJson`)
// and decodes it with `ComponentSerialization.CODEC` / `Style.Serializer.CODEC`
// over DFU's `JsonOps`. This module does the same in two stages: `parseValue`
// follows Gson's syntax and keeps spans, `Checker` applies the codec rules and
// reports the references inside the component.

import { charCount } from "../chars.ts";
import type { Effect } from "../command.ts";
import { ParseError } from "../diag.ts";
import { kind } from "../facts.ts";
import { type Node, parseValue, parseWholeLenientValue } from "../json.ts";
import { type PResult, Reader } from "../reader.ts";
import * as basic from "./basic.ts";
import * as entity from "./entity.ts";
import { type ArgCtx, readResourceLocation } from "./index.ts";
import * as nbt from "./nbt.ts";
import * as nbtCheck from "./nbt_check.ts";

export function component(r: Reader, cx: ArgCtx): PResult<void> {
  if (nbt.modern(cx.data)) return snbt(r, cx, "Text");
  return run(r, cx, "chat component", parseValueAtTop, (ck, node) => ck.component(node));
}

export function lenientComponent(r: Reader, cx: ArgCtx): PResult<void> {
  return run(r, cx, "chat component", parseWholeLenientValue, (ck, node) => ck.component(node));
}

function parseValueAtTop(r: Reader): PResult<Node> {
  return parseValue(r, 0);
}

export function style(r: Reader, cx: ArgCtx): PResult<void> {
  if (nbt.modern(cx.data)) return snbt(r, cx, "Style");
  return run(r, cx, "style", parseValueAtTop, (ck, node) =>
    node.json.kind === "Object" ? ck.styleFields(node.json.fields) : failAt(node, "Not a JSON object"),
  );
}

function snbt(r: Reader, cx: ArgCtx, category: nbtCheck.Category): PResult<void> {
  const node = nbt.parseTag(r, true);
  if (node instanceof ParseError) return node;
  nbt.check(cx, node, nbtCheck.new_(category, undefined));
  return undefined;
}

function run(
  r: Reader,
  cx: ArgCtx,
  what: string,
  parse: (r: Reader) => PResult<Node>,
  check: (ck: Checker, node: Node) => Check,
): PResult<void> {
  const node = parse(r);
  if (node instanceof ParseError) return new ParseError(node.start, node.end, `Invalid ${what}: ${node.message}`, node.severity);
  const failed = check(new Checker(cx, r.base), node);
  if (failed === undefined) return undefined;
  return new ParseError(r.offsetOf(failed.start), r.offsetOf(failed.end), `Invalid ${what}: ${failed.message}`);
}

class Fail {
  readonly start: number;
  readonly end: number;
  readonly message: string;

  constructor(start: number, end: number, message: string) {
    this.start = start;
    this.end = end;
    this.message = message;
  }
}

/** `undefined` is `Ok(())`. */
type Check = Fail | undefined;
type Fields = readonly (readonly [string, Node])[];

/** A container is marked at its first character; a long span adds nothing. */
function failAt(node: Node, message: string): Fail {
  const end = node.json.kind === "Array" || node.json.kind === "Object" ? node.start + 1 : node.end;
  return new Fail(node.start, end, message);
}

/** A key counts as absent when it is missing or `null`; the last duplicate wins. */
function get(fields: Fields, key: string): Node | undefined {
  for (let i = fields.length - 1; i >= 0; i--) {
    const [k, n] = fields[i]!;
    if (k === key) return n.json.kind === "Null" ? undefined : n;
  }
  return undefined;
}

function required(node: Node, fields: Fields, key: string): Node | Fail {
  return get(fields, key) ?? failAt(node, `No key ${key}`);
}

/** `Codec.STRING` on `JsonOps` accepts only JSON strings. */
function string(node: Node): string | Fail {
  return node.json.kind === "Str" ? node.json.value : failAt(node, "Not a string");
}

function stringField(node: Node, fields: Fields, key: string): [string, Node] | Fail {
  const value = required(node, fields, key);
  if (value instanceof Fail) return value;
  const s = string(value);
  return s instanceof Fail ? s : [s, value];
}

/** `Codec.BOOL` and `Codec.INT` also take numbers and booleans from each other. */
function isBoolOrNumber(node: Node): boolean {
  return node.json.kind === "Bool" || node.json.kind === "Num";
}

/** `i64::from_str_radix(text, 16)`: an optional sign, then at least one hex digit. */
function parseHexI64(text: string): bigint | undefined {
  if (!/^[+-]?[0-9a-fA-F]+$/.test(text)) return undefined;
  const negative = text.startsWith("-");
  const digits = text.replace(/^[+-]/, "").replace(/^0+/, "");
  if (digits.length > 16) return undefined;
  const magnitude = digits === "" ? 0n : BigInt(`0x${digits}`);
  const value = negative ? -magnitude : magnitude;
  return value >= -(2n ** 63n) && value < 2n ** 63n ? value : undefined;
}

function isResourceLocation(s: string): boolean {
  const r = new Reader(s, 0);
  return !(readResourceLocation(r) instanceof ParseError) && !r.canRead();
}

function resourceLocation(node: Node): Check {
  const s = string(node);
  if (s instanceof Fail) return s;
  return isResourceLocation(s) ? undefined : failAt(node, `Not a valid resource location: ${s}`);
}

function color(node: Node): Check {
  const s = string(node);
  if (s instanceof Fail) return s;
  let valid: boolean;
  if (s.startsWith("#")) {
    const v = parseHexI64(s.slice(1));
    valid = v !== undefined && v >= 0n && v <= 0xffffffn;
  } else {
    valid = s !== "reset" && basic.COLORS.includes(s);
  }
  return valid ? undefined : failAt(node, `Invalid color: ${s}`);
}

/** `ExtraCodecs.ARGB_COLOR_CODEC` (1.21.4): an int, or a list of four floats. */
function shadowColor(node: Node): Check {
  if (isBoolOrNumber(node)) return undefined;
  if (node.json.kind === "Array" && node.json.items.length === 4 && node.json.items.every(isBoolOrNumber)) return undefined;
  return failAt(node, "Not a number or a list of four numbers");
}

function clickEvent(node: Node): Check {
  if (node.json.kind !== "Object") return failAt(node, "Not a JSON object");
  const fields = node.json.fields;
  const action = required(node, fields, "action");
  if (action instanceof Fail) return action;
  const name = string(action);
  if (name instanceof Fail) return name;
  switch (name) {
    case "open_url":
    case "run_command":
    case "suggest_command":
    case "change_page":
    case "copy_to_clipboard":
      break;
    case "open_file":
      return failAt(action, "Action not allowed: open_file");
    default:
      return failAt(action, `Unknown element name:${name}`);
  }
  const value = stringField(node, fields, "value");
  return value instanceof Fail ? value : undefined;
}

/** `UUID.fromString` takes five dash-separated hex numbers, each fitting a long. */
export function isJavaUuid(s: string): boolean {
  const parts = s.split("-");
  return charCount(s) <= 36 && parts.length === 5 && parts.every((p) => parseHexI64(p) !== undefined);
}

function uuid(node: Node): Check {
  const json = node.json;
  if (json.kind === "Array" && json.items.length === 4 && json.items.every(isBoolOrNumber)) return undefined;
  if (json.kind === "Str") return isJavaUuid(json.value) ? undefined : failAt(node, `Invalid UUID ${json.value}`);
  return failAt(node, "Not a UUID");
}

/** The `tag` string is SNBT; the NBT parsers are responsible for its contents. */
function itemInfo(node: Node): Check {
  const json = node.json;
  if (json.kind === "Str") return resourceLocation(node);
  if (json.kind !== "Object") return failAt(node, "Not an item stack");
  const id = required(node, json.fields, "id");
  if (id instanceof Fail) return id;
  const idCheck = resourceLocation(id);
  if (idCheck !== undefined) return idCheck;
  const count = get(json.fields, "count");
  if (count !== undefined && !isBoolOrNumber(count)) return failAt(count, "Not a number");
  const tag = get(json.fields, "tag");
  if (tag === undefined) return undefined;
  const tagText = string(tag);
  return tagText instanceof Fail ? tagText : undefined;
}

type Content = "Text" | "Translatable" | "Keybind" | "Score" | "Selector" | "Nbt";

/** (value of `type`, key that selects it when `type` is absent, contents) */
const CONTENTS: readonly (readonly [string, string, Content])[] = [
  ["text", "text", "Text"],
  ["translatable", "translate", "Translatable"],
  ["keybind", "keybind", "Keybind"],
  ["score", "score", "Score"],
  ["selector", "selector", "Selector"],
  ["nbt", "nbt", "Nbt"],
];

const CONTENT_KEYS: readonly (readonly [string, Content])[] = CONTENTS.map(([, key, content]) => [key, content]);

type Source = "Entity" | "Block" | "Storage";

/** (value of `source`, which is also the key that selects it) */
const SOURCES: readonly (readonly [string, Source])[] = [
  ["entity", "Entity"],
  ["block", "Block"],
  ["storage", "Storage"],
];

type HoverAction = "Text" | "Item" | "Entity";

function truncate(effects: Effect[], length: number): void {
  if (length < effects.length) effects.length = length;
}

/** Later passes may rewrite the offsets of an effect in place, so a replayed effect is a copy. */
function cloneEffect(e: Effect): Effect {
  switch (e.kind) {
    case "Diag":
      return { kind: "Diag", diag: { ...e.diag } };
    case "Ref":
      return { kind: "Ref", ref: { ...e.ref } };
    case "Write":
      return { kind: "Write", ref: { ...e.ref } };
    case "Def":
      return { kind: "Def", def: { ...e.def } };
  }
}

class Checker {
  readonly cx: ArgCtx;
  readonly base: number;
  /** By nesting depth, the result and effects of each component already checked at that depth. */
  readonly components: Map<Node, [Check, Effect[]]>[] = [];
  depth = 0;

  constructor(cx: ArgCtx, base: number) {
    this.cx = cx;
    this.base = base;
  }

  component(node: Node): Check {
    const depth = this.depth;
    const known = this.components[depth]?.get(node);
    if (known !== undefined) {
      const [check, effects] = known;
      for (const e of effects) this.cx.effects.push(cloneEffect(e));
      return check;
    }
    const mark = this.cx.effects.length;
    this.depth += 1;
    const check = this.decodeComponent(node);
    this.depth = depth;
    // Like `Vec::resize_with`: the maps deeper than this one are dropped.
    if (this.components.length > depth + 1) this.components.length = depth + 1;
    while (this.components.length < depth + 1) this.components.push(new Map());
    this.components[depth]!.set(node, [check, this.cx.effects.slice(mark)]);
    return check;
  }

  decodeComponent(node: Node): Check {
    const json = node.json;
    switch (json.kind) {
      case "Str":
        return undefined;
      case "Array":
        return this.componentList(node, json.items);
      case "Object": {
        const fields = json.fields;
        const contents = this.contents(node, fields);
        if (contents !== undefined) return contents;
        if (this.cx.config.spyglass) this.nbtOnlyKeys(fields);
        const extra = get(fields, "extra");
        if (extra !== undefined) {
          if (extra.json.kind !== "Array") return failAt(extra, "Not a JSON array");
          const list = this.componentList(extra, extra.json.items);
          if (list !== undefined) return list;
        }
        return this.styleFields(fields);
      }
      default:
        return failAt(node, "Expected a string, array or object");
    }
  }

  /** mcdoc's text component lets `interpret` appear only with `nbt`; vanilla
   * ignores it elsewhere. The modified Spyglass reports both keys. */
  nbtOnlyKeys(fields: Fields): void {
    if (get(fields, "nbt") !== undefined) return;
    const interpret = get(fields, "interpret");
    if (interpret === undefined) return;
    let found: [string, Node] | undefined;
    for (const k of ["text", "translate", "score", "selector", "keybind"]) {
      const n = get(fields, k);
      if (n !== undefined) {
        found = [k, n];
        break;
      }
    }
    if (found === undefined) return;
    const [content, node] = found;
    const message = `Invalid combination of keys “interpret” and “${content}”`;
    for (const n of [node, interpret]) {
      if (n.key !== undefined) {
        const [start, end] = n.key;
        this.cx.diag(this.base + start, this.base + end, "Error", "jsonKeyCombination", message);
      }
    }
  }

  componentList(node: Node, items: readonly Node[]): Check {
    if (items.length === 0) return failAt(node, "List must have contents");
    for (const item of items) {
      const check = this.component(item);
      if (check !== undefined) return check;
    }
    return undefined;
  }

  contents(node: Node, fields: Fields): Check {
    const typeNode = get(fields, "type");
    if (typeNode !== undefined) {
      const name = string(typeNode);
      if (name instanceof Fail) return name;
      const found = CONTENTS.find(([typeName]) => typeName === name);
      return found === undefined ? failAt(typeNode, `Unknown element name:${name}`) : this.content(found[2], node, fields);
    }
    return this.firstMatch(node, fields, CONTENT_KEYS, (content) => this.content(content, node, fields));
  }

  /** Without a `type`/`source` discriminator vanilla tries each alternative in order
   * and keeps the first that decodes. A failed alternative must leave no references. */
  firstMatch<T>(node: Node, fields: Fields, options: readonly (readonly [string, T])[], check: (option: T) => Check): Check {
    let reported: Fail | undefined;
    for (const [key, option] of options) {
      const mark = this.cx.effects.length;
      const failed = check(option);
      if (failed === undefined) return undefined;
      truncate(this.cx.effects, mark);
      if (reported === undefined && get(fields, key) !== undefined) reported = failed;
    }
    return reported ?? failAt(node, "No matching codec found");
  }

  content(content: Content, node: Node, fields: Fields): Check {
    switch (content) {
      case "Text": {
        const text = stringField(node, fields, "text");
        return text instanceof Fail ? text : undefined;
      }
      case "Keybind": {
        const keybind = stringField(node, fields, "keybind");
        return keybind instanceof Fail ? keybind : undefined;
      }
      case "Translatable": {
        // `fallback` is a lenient optional field: a wrong type is ignored.
        const translate = stringField(node, fields, "translate");
        if (translate instanceof Fail) return translate;
        const withNode = get(fields, "with");
        if (withNode === undefined) return undefined;
        if (withNode.json.kind !== "Array") return failAt(withNode, "Not a JSON array");
        for (const arg of withNode.json.items) {
          switch (arg.json.kind) {
            case "Str":
            case "Num":
            case "Bool":
              break;
            case "Array":
            case "Object": {
              const check = this.component(arg);
              if (check !== undefined) return check;
              break;
            }
            case "Null":
              return failAt(arg, "Not a component");
          }
        }
        return undefined;
      }
      case "Score": {
        const score = required(node, fields, "score");
        if (score instanceof Fail) return score;
        if (score.json.kind !== "Object") return failAt(score, "Not a JSON object");
        const inner = score.json.fields;
        const nameField = stringField(score, inner, "name");
        if (nameField instanceof Fail) return nameField;
        const objectiveField = stringField(score, inner, "objective");
        if (objectiveField instanceof Fail) return objectiveField;
        const [name, nameNode] = nameField;
        const [objective, objectiveNode] = objectiveField;
        if (name.startsWith("@")) {
          this.selector(name, nameNode);
        } else if (name !== "*") {
          const [start, end] = this.span(nameNode);
          this.cx.referenceName(kind.SCORE_HOLDER, name, start, end);
        }
        const [objectiveStart, objectiveEnd] = this.span(objectiveNode);
        this.cx.referenceName(kind.OBJECTIVE, objective, objectiveStart, objectiveEnd);
        return undefined;
      }
      case "Selector": {
        const patternField = stringField(node, fields, "selector");
        if (patternField instanceof Fail) return patternField;
        const [pattern, patternNode] = patternField;
        const separator = get(fields, "separator");
        if (separator !== undefined) {
          const check = this.component(separator);
          if (check !== undefined) return check;
        }
        if (pattern.startsWith("@")) this.selector(pattern, patternNode);
        return undefined;
      }
      case "Nbt": {
        const nbtField = stringField(node, fields, "nbt");
        if (nbtField instanceof Fail) return nbtField;
        // `interpret` and `separator` are lenient optional fields too.
        const separator = get(fields, "separator");
        if (separator !== undefined) {
          const mark = this.cx.effects.length;
          if (this.component(separator) !== undefined) truncate(this.cx.effects, mark);
        }
        return this.dataSource(node, fields);
      }
    }
  }

  dataSource(node: Node, fields: Fields): Check {
    const typeNode = get(fields, "source");
    if (typeNode !== undefined) {
      const name = string(typeNode);
      if (name instanceof Fail) return name;
      const found = SOURCES.find(([key]) => key === name);
      return found === undefined ? failAt(typeNode, `Unknown element name:${name}`) : this.source(found[1], node, fields);
    }
    return this.firstMatch(node, fields, SOURCES, (source) => this.source(source, node, fields));
  }

  source(source: Source, node: Node, fields: Fields): Check {
    switch (source) {
      case "Entity": {
        const patternField = stringField(node, fields, "entity");
        if (patternField instanceof Fail) return patternField;
        const [pattern, patternNode] = patternField;
        if (pattern.startsWith("@")) this.selector(pattern, patternNode);
        return undefined;
      }
      case "Block": {
        const block = stringField(node, fields, "block");
        return block instanceof Fail ? block : undefined;
      }
      case "Storage": {
        const value = required(node, fields, "storage");
        if (value instanceof Fail) return value;
        const valid = resourceLocation(value);
        if (valid !== undefined) return valid;
        const [start, end] = this.span(value);
        if (value.json.kind === "Str") this.cx.reference(kind.STORAGE, value.json.value, start, end);
        return undefined;
      }
    }
  }

  styleFields(fields: Fields): Check {
    const colorNode = get(fields, "color");
    if (colorNode !== undefined) {
      const check = color(colorNode);
      if (check !== undefined) return check;
    }
    const shadowNode = get(fields, "shadow_color");
    if (this.cx.data.atLeast([1, 21, 4]) && shadowNode !== undefined) {
      const check = shadowColor(shadowNode);
      if (check !== undefined) return check;
    }
    for (const key of ["bold", "italic", "underlined", "strikethrough", "obfuscated"]) {
      const value = get(fields, key);
      if (value !== undefined && !isBoolOrNumber(value)) return failAt(value, "Not a boolean");
    }
    const clickNode = get(fields, "clickEvent");
    if (clickNode !== undefined) {
      const check = clickEvent(clickNode);
      if (check !== undefined) return check;
    }
    const hoverNode = get(fields, "hoverEvent");
    if (hoverNode !== undefined) {
      const check = this.hoverEvent(hoverNode);
      if (check !== undefined) return check;
    }
    const insertion = get(fields, "insertion");
    if (insertion !== undefined) {
      const check = string(insertion);
      if (check instanceof Fail) return check;
    }
    const font = get(fields, "font");
    return font === undefined ? undefined : resourceLocation(font);
  }

  /** `{action, contents}`, or the legacy `{action, value}` that holds a component. */
  hoverEvent(node: Node): Check {
    if (node.json.kind !== "Object") return failAt(node, "Not a JSON object");
    const fields = node.json.fields;
    const actionNode = required(node, fields, "action");
    if (actionNode instanceof Fail) return actionNode;
    const name = string(actionNode);
    if (name instanceof Fail) return name;
    let action: HoverAction;
    switch (name) {
      case "show_text":
        action = "Text";
        break;
      case "show_item":
        action = "Item";
        break;
      case "show_entity":
        action = "Entity";
        break;
      default:
        return failAt(actionNode, `Unknown element name:${name}`);
    }
    const mark = this.cx.effects.length;
    const contents = required(node, fields, "contents");
    let modern: Check;
    if (contents instanceof Fail) modern = contents;
    else if (action === "Text") modern = this.component(contents);
    else if (action === "Item") modern = itemInfo(contents);
    else modern = this.entityInfo(contents);
    if (modern === undefined) return undefined;
    truncate(this.cx.effects, mark);
    // Legacy show_item and show_entity carry SNBT inside the component text; not checked here.
    const legacy = get(fields, "value");
    if (legacy !== undefined && this.component(legacy) === undefined) return undefined;
    truncate(this.cx.effects, mark);
    return modern;
  }

  entityInfo(node: Node): Check {
    if (node.json.kind !== "Object") return failAt(node, "Not a JSON object");
    const fields = node.json.fields;
    const type = required(node, fields, "type");
    if (type instanceof Fail) return type;
    const typeCheck = resourceLocation(type);
    if (typeCheck !== undefined) return typeCheck;
    const id = required(node, fields, "id");
    if (id instanceof Fail) return id;
    const idCheck = uuid(id);
    if (idCheck !== undefined) return idCheck;
    const name = get(fields, "name");
    return name === undefined ? undefined : this.component(name);
  }

  /** File offsets of a string node's content, without the quotes. */
  span(node: Node): [number, number] {
    return [this.base + node.start + 1, this.base + node.end - 1];
  }

  /** Selectors in components are parsed only for the references they hold; vanilla
   * ignores one that fails. Escapes shift offsets, so they stay approximate. */
  selector(text: string, node: Node): void {
    const mark = this.cx.effects.length;
    const reader = new Reader(text, this.span(node)[0]);
    if (entity.selector(reader, this.cx) instanceof ParseError) truncate(this.cx.effects, mark);
  }
}
