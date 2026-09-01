const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

export class CodecError extends Error {
  override name = "CodecError";
}

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol
export const KNOWN_SYMBOLS = [
  Symbol.asyncIterator,
  Symbol.hasInstance,
  Symbol.isConcatSpreadable,
  Symbol.iterator,
  Symbol.match,
  Symbol.matchAll,
  Symbol.replace,
  Symbol.search,
  Symbol.species,
  Symbol.split,
  Symbol.toPrimitive,
  Symbol.toStringTag,
  Symbol.unscopables,
];

/**
 * How values that cannot be represented by structure alone — functions, class
 * instances, promises — are exchanged: as an id one thread can resolve back to
 * the live object on the other.
 */
export interface References {
  /**
   * The id this value already has on the other thread, if it has one.
   *
   * Consulted before anything is inspected structurally, because a proxy for a
   * remote object looks exactly like a plain object from the outside: its
   * identity is the whole of its meaning, and encoding its shape instead would
   * quietly send an empty record in its place.
   */
  identify?(value: object | Function): string | undefined;
  encode(value: object | Function): string;
  decode(id: string): unknown;
}

const withoutReferences: References = {
  identify: () => undefined,
  encode(value) {
    throw new CodecError(`Cannot encode ${describe(value)} without references`);
  },
  decode(id) {
    throw new CodecError(`Cannot decode reference "${id}" without references`);
  },
};

const describe = (value: unknown) =>
  typeof value === "function"
    ? `function ${(value as Function).name || "(anonymous)"}`
    : `an instance of ${(value as object)?.constructor?.name ?? "unknown"}`;

/** Bumped whenever the meaning of what follows changes. */
const VERSION = 1;

const TAG = {
  undefined: 0,
  null: 1,
  false: 2,
  true: 3,
  number: 4,
  date: 5,
  symbol: 6,
  string: 7,
  bigint: 8,
  bytes: 9,
  arrayBuffer: 10,
  array: 11,
  record: 12,
  map: 13,
  set: 14,
  error: 15,
  reference: 16,
} as const;

type Tag = (typeof TAG)[keyof typeof TAG];

/** Buffer that grows as values are appended to it. */
class Writer {
  private bytes = new Uint8Array(1024);
  private view = new DataView(this.bytes.buffer);
  private length = 0;

  private reserve(count: number) {
    const required = this.length + count;
    if (required <= this.bytes.byteLength) return;
    let capacity = this.bytes.byteLength;
    while (capacity < required) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }

  u8(value: number) {
    this.reserve(1);
    this.bytes[this.length++] = value;
  }

  u32(value: number) {
    this.reserve(4);
    this.view.setUint32(this.length, value, true);
    this.length += 4;
  }

  f64(value: number) {
    this.reserve(8);
    this.view.setFloat64(this.length, value, true);
    this.length += 8;
  }

  blob(value: Uint8Array) {
    this.u32(value.byteLength);
    this.reserve(value.byteLength);
    this.bytes.set(value, this.length);
    this.length += value.byteLength;
  }

  text(value: string) {
    this.blob(encoder.encode(value));
  }

  finish() {
    return this.bytes.subarray(0, this.length);
  }
}

/** Cursor that reads back what a {@link Writer} appended, in the same order. */
class Reader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Reading past the end means the payload was truncated, not that it lied. */
  private take(count: number) {
    const start = this.offset;
    if (start + count > this.bytes.byteLength)
      throw new CodecError(
        `Payload is truncated: wanted ${count} bytes at ${start} of ${this.bytes.byteLength}`,
      );
    this.offset += count;
    return start;
  }

  u8() {
    return this.bytes[this.take(1)];
  }

  u32() {
    return this.view.getUint32(this.take(4), true);
  }

  f64() {
    return this.view.getFloat64(this.take(8), true);
  }

  blob() {
    const length = this.u32();
    const start = this.take(length);
    return this.bytes.subarray(start, start + length);
  }

  text() {
    return decoder.decode(this.blob());
  }
}

const isPlainObject = (value: object) => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const tagOfPrimitive = (value: unknown): Tag | undefined => {
  if (value === undefined) return TAG.undefined;
  if (value === null) return TAG.null;
  if (value === false) return TAG.false;
  if (value === true) return TAG.true;
  if (typeof value === "number") return TAG.number;
  if (typeof value === "string") return TAG.string;
  if (typeof value === "bigint") return TAG.bigint;
  if (typeof value === "symbol") return TAG.symbol;
  return undefined;
};

const tagOfObject = (value: object): Tag => {
  if (value instanceof Uint8Array) return TAG.bytes;
  if (value instanceof ArrayBuffer) return TAG.arrayBuffer;
  if (value instanceof Date) return TAG.date;
  if (value instanceof Error) return TAG.error;
  if (value instanceof Map) return TAG.map;
  if (value instanceof Set) return TAG.set;
  if (Array.isArray(value)) return TAG.array;
  return isPlainObject(value) ? TAG.record : TAG.reference;
};

const classify = (value: unknown): Tag =>
  tagOfPrimitive(value) ??
  (typeof value === "function" ? TAG.reference : tagOfObject(value as object));

const CONTAINERS = new Set<Tag>([TAG.array, TAG.record, TAG.map, TAG.set]);

type Context = { references: References; seen: Set<object> };

const SYMBOL_KIND = { known: 0, registered: 1, local: 2 } as const;

const writeSymbol = (writer: Writer, value: symbol) => {
  const known = KNOWN_SYMBOLS.indexOf(value);
  if (known >= 0) return writeSymbolAs(writer, SYMBOL_KIND.known, `${known}`);
  const registered = Symbol.keyFor(value);
  if (registered !== undefined)
    return writeSymbolAs(writer, SYMBOL_KIND.registered, registered);
  writeSymbolAs(writer, SYMBOL_KIND.local, value.description ?? "");
};

const writeSymbolAs = (writer: Writer, kind: number, key: string) => {
  writer.u8(kind);
  writer.text(key);
};

/**
 * A symbol that is neither well known nor registered has no counterpart on the
 * other thread, so it arrives as a new symbol carrying the same description.
 */
const readSymbol = (reader: Reader): symbol => {
  const kind = reader.u8();
  const key = reader.text();
  if (kind === SYMBOL_KIND.known) return KNOWN_SYMBOLS[Number(key)];
  if (kind === SYMBOL_KIND.registered) return Symbol.for(key);
  return Symbol(key);
};

const writeFields = (
  writer: Writer,
  entries: [string, unknown][],
  context: Context,
) => {
  writer.u32(entries.length);
  for (const [key, value] of entries) {
    writer.text(key);
    write(writer, value, context);
  }
};

const readFields = (reader: Reader, context: Context) => {
  const record: Record<string, unknown> = {};
  for (let count = reader.u32(); count > 0; count--)
    record[reader.text()] = read(reader, context);
  return record;
};

const writeValues = (
  writer: Writer,
  values: Iterable<unknown>,
  size: number,
  context: Context,
) => {
  writer.u32(size);
  for (const value of values) write(writer, value, context);
};

const readValues = (reader: Reader, context: Context) => {
  const values = new Array<unknown>(reader.u32());
  for (let index = 0; index < values.length; index++)
    values[index] = read(reader, context);
  return values;
};

const writeError = (writer: Writer, error: Error) => {
  writer.text(error.name);
  writer.text(error.message);
  writer.text(error.stack ?? "");
};

const readError = (reader: Reader) => {
  const [name, message, stack] = [reader.text(), reader.text(), reader.text()];
  const error = new Error(message);
  error.name = name;
  if (stack) error.stack = stack;
  return error;
};

const encoders: Record<Tag, (w: Writer, value: any, context: Context) => void> =
  {
    [TAG.undefined]: () => {},
    [TAG.null]: () => {},
    [TAG.false]: () => {},
    [TAG.true]: () => {},
    [TAG.number]: (w, value: number) => w.f64(value),
    [TAG.date]: (w, value: Date) => w.f64(value.getTime()),
    [TAG.symbol]: (w, value: symbol) => writeSymbol(w, value),
    [TAG.string]: (w, value: string) => w.text(value),
    [TAG.bigint]: (w, value: bigint) => w.text(value.toString()),
    [TAG.bytes]: (w, value: Uint8Array) => w.blob(value),
    [TAG.arrayBuffer]: (w, value: ArrayBuffer) => w.blob(new Uint8Array(value)),
    [TAG.array]: (w, value: unknown[], c) =>
      writeValues(w, value, value.length, c),
    [TAG.set]: (w, value: Set<unknown>, c) =>
      writeValues(w, value, value.size, c),
    /** Own enumerable string keys only: symbol keys and getters are not sent. */
    [TAG.record]: (w, value: object, c) =>
      writeFields(w, Object.entries(value), c),
    [TAG.map]: (w, value: Map<unknown, unknown>, c) =>
      writeValues(w, flatten(value), value.size * 2, c),
    [TAG.error]: (w, value: Error) => writeError(w, value),
    [TAG.reference]: (w, value: object, c) =>
      w.text(c.references.encode(value)),
  };

const decoders: Record<Tag, (reader: Reader, context: Context) => unknown> = {
  [TAG.undefined]: () => undefined,
  [TAG.null]: () => null,
  [TAG.false]: () => false,
  [TAG.true]: () => true,
  [TAG.number]: (r) => r.f64(),
  [TAG.date]: (r) => new Date(r.f64()),
  [TAG.symbol]: (r) => readSymbol(r),
  [TAG.string]: (r) => r.text(),
  [TAG.bigint]: (r) => BigInt(r.text()),
  [TAG.bytes]: (r) => r.blob().slice(),
  [TAG.arrayBuffer]: (r) => r.blob().slice().buffer,
  [TAG.array]: (r, c) => readValues(r, c),
  [TAG.set]: (r, c) => new Set(readValues(r, c)),
  [TAG.record]: (r, c) => readFields(r, c),
  [TAG.map]: (r, c) => new Map(pairs(readValues(r, c))),
  [TAG.error]: (r) => readError(r),
  [TAG.reference]: (r, c) => c.references.decode(r.text()),
};

function* flatten(map: Map<unknown, unknown>) {
  for (const entry of map) yield* entry;
}

function* pairs(values: unknown[]): Generator<[unknown, unknown]> {
  for (let index = 0; index < values.length; index += 2)
    yield [values[index], values[index + 1]];
}

const enterContainer = ({ seen }: Context, value: object) => {
  if (seen.has(value))
    throw new CodecError("Cannot encode a circular structure");
  seen.add(value);
};

/** Only objects and functions can belong to the other thread. */
const identifierOf = (value: unknown, { references }: Context) =>
  value !== null && (typeof value === "object" || typeof value === "function")
    ? references.identify?.(value as object)
    : undefined;

const write = (writer: Writer, value: unknown, context: Context) => {
  const identifier = identifierOf(value, context);
  if (identifier !== undefined) {
    writer.u8(TAG.reference);
    return writer.text(identifier);
  }

  const tag = classify(value);
  writer.u8(tag);
  if (!CONTAINERS.has(tag)) return encoders[tag](writer, value, context);
  enterContainer(context, value as object);
  encoders[tag](writer, value, context);
  context.seen.delete(value as object);
};

const read = (reader: Reader, context: Context): any => {
  const tag = reader.u8() as Tag;
  const decode = decoders[tag];
  if (!decode) throw new CodecError(`Unknown tag ${tag}`);
  return decode(reader, context);
};

const rejectShared = (bytes: Uint8Array) => {
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    bytes.buffer instanceof SharedArrayBuffer
  )
    throw new CodecError("Cannot decode directly from shared memory");
  return bytes;
};

const readVersion = (reader: Reader) => {
  const version = reader.u8();
  if (version !== VERSION)
    throw new CodecError(
      `Payload is version ${version}, but this codec speaks version ${VERSION}`,
    );
};

export const codec = {
  /**
   * The same value appearing twice is written twice: only cycles are refused,
   * not repetition. Payloads here are small and shallow enough that an index
   * table would cost more than it saves.
   */
  encode(value: unknown, references: References = withoutReferences) {
    const writer = new Writer();
    writer.u8(VERSION);
    write(writer, value, { references, seen: new Set() });
    return writer.finish();
  },

  decode(bytes: Uint8Array, references: References = withoutReferences) {
    const reader = new Reader(rejectShared(bytes));
    readVersion(reader);
    return read(reader, { references, seen: new Set() });
  },
};
