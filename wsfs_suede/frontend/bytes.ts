/**
 * Content-addressed bytes.
 *
 * An outbox entry is a row of pointers: the payload it would send lives here,
 * under its sha256. Two writes of the same content cost one copy, a blob is
 * verifiable against its own name, and a queue that has been offline all day
 * is a list of hashes rather than a list of documents.
 */
export type Digest = string;

export type Store = {
  /**
   * @param content
   * `at` is the digest when the caller has already computed it -- which it
   * has whenever it needed to write the row that NAMES these bytes before
   * storing them. Hashing a payload twice is the only alternative.
   * @param at
   * @returns
   */
  put: (content: Uint8Array | string, at?: Digest) => Promise<Digest>;
  read: (digest: Digest) => Promise<Uint8Array | undefined>;
  text: (digest: Digest) => Promise<string | undefined>;
  forget: (digests: Iterable<Digest>) => Promise<void>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const bytesOf = (content: Uint8Array | string) =>
  typeof content === "string" ? encoder.encode(content) : content;

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * The server verifies a blob against its own name, so this has to be sha256
 * and it has to be the platform's.
 *
 * `crypto.subtle` exists only on a secure origin -- https, or localhost.
 * Reached over plain http at an IP address, the whole namespace is simply
 * absent, and the failure is otherwise a `TypeError` about reading `digest`
 * of undefined, which says nothing about the cause. Anything that needs
 * another kind of key can pass its own `Store`.
 */
export const digestOf = async (
  content: Uint8Array | string,
): Promise<Digest> => {
  if (typeof crypto === "undefined" || crypto.subtle === undefined) {
    throw new Error(
      "crypto.subtle is unavailable, so content cannot be hashed. " +
        "Browsers withhold it from insecure origins: serve this over https, " +
        "or reach it on localhost.",
    );
  }
  return hex(
    await crypto.subtle.digest("SHA-256", bytesOf(content) as BufferSource),
  );
};

/**
 * The store the browser has before IndexedDB is wired up, and the one tests
 * use. Losing it loses queued payloads, which is why it is not the default
 * anywhere a user can reach.
 */
export const inMemory = (): Store => {
  const bytesByDigest = new Map<Digest, Uint8Array>();
  return {
    put: async (content, at) => {
      const digest = at ?? (await digestOf(content));
      bytesByDigest.set(digest, bytesOf(content));
      return digest;
    },
    read: async (digest) => bytesByDigest.get(digest),
    text: async (digest) => {
      const bytes = bytesByDigest.get(digest);
      return bytes === undefined ? undefined : decoder.decode(bytes);
    },
    forget: async (digests) => {
      for (const digest of digests) bytesByDigest.delete(digest);
    },
  };
};

export const asText = (bytes: Uint8Array) => decoder.decode(bytes);
export const asBytes = (text: string) => encoder.encode(text);
