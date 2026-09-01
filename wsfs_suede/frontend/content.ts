/**
 * Reading a file, in the order the answers are trustworthy.
 *
 *   1. the cache, keyed by the content token the last event announced
 *   2. the server
 *
 * The cache is keyed by TOKEN rather than by id, which is what makes it
 * correct without an invalidation step: a `write` event advances the token, so
 * the cache line for the old one simply stops being asked for.
 *
 * WHO ELSE to trust is not decided here. An editor holding a buffer somebody
 * is typing into knows something this does not, and it is the consumer that
 * knows it has one -- so preferring it is the consumer's rule to write, over
 * the top of this.
 */
import { asText } from "./bytes";
import type { Id, Metadata, Version } from "./contract";

export type Payload =
  | { kind: "text"; text: string }
  | { kind: "binary"; bytes: Uint8Array; mime: string };

export type Fetch = (entry: Id, version: Version) => Promise<Payload>;

export type Content = {
  /** What the file holds now, from wherever can answer soonest. */
  read: (entry: Metadata) => Promise<Payload | undefined>;
  /** What is already in hand, with no network and no waiting. */
  holding: (entry: Metadata) => Payload | undefined;
  /**
   * Pull an entry's content into the cache before anybody asks for it, so the
   * kernel's synchronous filesystem calls can be answered out of state rather
   * than out of a request it would have to block on.
   */
  prefetch: (entry: Metadata) => Promise<void>;
  /**
   * What a write this client just queued put there, under the token it will
   * be recorded against.
   *
   * The token is the transaction id, which the client minted and the server
   * records unchanged -- so this line is right before the server has heard of
   * it and stays right afterwards. Without it a file cannot be read back
   * until it is confirmed, which is the one thing an offline client cannot
   * wait for.
   */
  remember: (version: Version, content: Payload) => void;
  forget: (entry: Id) => void;
};

const keyed = (entry: Metadata) => entry.content_version ?? undefined;

export const cache = (fetch: Fetch): Content => {
  const held = new Map<Version, Payload>();
  const byEntry = new Map<Id, Version>();
  const arriving = new Map<Version, Promise<Payload>>();

  const cached = (version: Version | undefined) =>
    version === undefined ? undefined : held.get(version);

  const fetched = async (entry: Metadata, version: Version) => {
    const already = arriving.get(version);
    if (already) return already;
    const request = fetch(entry.id, version).then((content) => {
      held.set(version, content);
      byEntry.set(entry.id, version);
      arriving.delete(version);
      return content;
    });
    arriving.set(version, request);
    return request;
  };

  const holding = (entry: Metadata) => cached(keyed(entry));

  return {
    holding,
    remember: (version, content) => {
      held.set(version, content);
    },
    forget: (entry) => {
      const version = byEntry.get(entry);
      if (version !== undefined) held.delete(version);
      byEntry.delete(entry);
    },
    read: async (entry) => {
      const inHand = holding(entry);
      if (inHand) return inHand;
      const version = keyed(entry);
      return version === undefined ? undefined : fetched(entry, version);
    },
    prefetch: async (entry) => {
      if (holding(entry)) return;
      const version = keyed(entry);
      if (version !== undefined)
        await fetched(entry, version).catch(() => undefined);
    },
  };
};

export const textOf = (content: Payload) =>
  content.kind === "text" ? content.text : asText(content.bytes);
