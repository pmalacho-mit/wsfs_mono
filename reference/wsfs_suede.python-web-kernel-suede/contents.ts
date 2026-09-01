const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * The contents of a file as they cross the kernel bridge.
 *
 * Strings are UTF-8 text, byte arrays are passed through untouched.
 */
export type Contents = string | Uint8Array;

const isText = (value: Contents): value is string => typeof value === "string";

const decodeText = (bytes: Uint8Array): string | undefined => {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return undefined;
  }
};

export const contents = {
  isText,

  toBytes: (value: Contents): Uint8Array =>
    isText(value) ? encoder.encode(value) : value,

  /**
   * Bytes become text whenever they are valid UTF-8, so text written by Python
   * arrives as text and anything else arrives untouched.
   */
  fromBytes: (bytes: Uint8Array): Contents => decodeText(bytes) ?? bytes,

  byteLength: (value: Contents): number =>
    isText(value) ? encoder.encode(value).byteLength : value.byteLength,

  equal: (left: Contents, right: Contents): boolean => {
    const [a, b] = [contents.toBytes(left), contents.toBytes(right)];
    return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
  },
};

/** Grows with zero padding or truncates, matching `ftruncate` semantics. */
export const resizeBytes = (bytes: Uint8Array, size: number): Uint8Array => {
  if (size <= bytes.byteLength) return bytes.slice(0, size);
  const resized = new Uint8Array(size);
  resized.set(bytes);
  return resized;
};
