/**
 * The wire, spoken.
 *
 * Nothing here decides anything. It is handed where the router is mounted and
 * how to authenticate, because both belong to whoever mounted it, and it
 * turns the generated shapes into requests.
 */
import type { Payload } from "./content";
import type {
  History,
  Id,
  Response,
  Snapshot,
  StreamEvent,
  Submitted,
  Transaction,
  Version,
} from "./contract";
import { paged, requesting, type Authorized } from "./requests";

export type { Authorized };

export type Reading = {
  /** Any traffic at all, heartbeats included -- what a watchdog is armed on. */
  alive: () => void;
  event: (event: StreamEvent) => void;
  failed: (reason: unknown) => void;
};

export type Subscription = { close: () => void };

export type Transport = {
  initialize: (workspace: Id, outbox: Submitted[]) => Promise<Snapshot>;
  /**
   * `keepalive` is for the last write of a session, made as the page is going
   * away. An ordinary fetch is cancelled along with the document that made
   * it, so the work a person typed in the seconds before they closed the tab
   * never leaves the machine -- see `Workspace.rescue`. Bodies are capped at
   * 64KB across all in-flight keepalive requests, which is why it is the
   * exception and not the rule.
   */
  submit: (
    workspace: Id,
    request: Submitted,
    options?: { keepalive?: boolean },
  ) => Promise<Response>;
  content: (workspace: Id, entry: Id, version?: Version) => Promise<Payload>;
  uploadBytes: (
    workspace: Id,
    digest: string,
    bytes: Uint8Array,
    mime: string,
  ) => Promise<void>;
  cleared: (workspace: Id, transactions: Transaction[]) => Promise<void>;
  /**
   * The collaboration room for one entry, as this host serves it.
   *
   * ON THE TRANSPORT, with everything else that talks to the server. These
   * were bare `fetch` calls to a path built by hand, which is how they went
   * on calling routes that had moved -- and, once found, how they went on
   * calling them without the caller's authorisation. One door, one base URL,
   * one auth story.
   */
  bringRoomUpToFile: (workspace: Id, entry: Id) => Promise<Version | null>;
  warmRoom: (workspace: Id, entry: Id) => Promise<void>;
  roomStored: (workspace: Id, entry: Id, version: Version) => Promise<void>;
  handOver: (workspace: Id, entry: Id, update: Uint8Array) => Promise<void>;
  /** What this file has said, newest first, as far back as `before`. */
  history: (
    workspace: Id,
    entry: Id,
    asking: { before?: string; limit?: number },
  ) => Promise<History>;
  follow: (workspace: Id, token: string, reading: Reading) => Subscription;
};

type Response_ = globalThis.Response;

const payloadOf = async (response: Response_): Promise<Payload> => {
  const mime =
    response.headers.get("content-type") ?? "application/octet-stream";
  if (!mime.startsWith("application/json")) {
    return {
      kind: "binary",
      bytes: new Uint8Array(await response.arrayBuffer()),
      mime,
    };
  }
  const body = (await response.json()) as { content: string };
  return { kind: "text", text: body.content };
};

/**
 * SSE read with `fetch` rather than `EventSource`, for two reasons.
 *
 * `EventSource` reconnects on its own, and it reconnects to the same URL --
 * which carries a token that was spent the first time. Every reconnection has
 * to go back through Initialize for a fresh one.
 *
 * And `EventSource` drops comment lines, so the heartbeats are invisible to
 * it. A watchdog armed on messages alone cannot tell a quiet workspace from a
 * proxy quietly eating the stream, which is the exact failure it is for.
 */
const read = async (body: ReadableStream<Uint8Array>, reading: Reading) => {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    reading.alive();
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      reading.event(JSON.parse(line.slice("data: ".length)) as StreamEvent);
    }
  }
};

export const http = (base: string, authorize: Authorized): Transport => {
  const { workspaces, send, posted, json } = requesting(base, authorize);
  const at = (path: string) => `${base.replace(/\/$/, "")}${path}`;

  return {
    initialize: async (workspace, outbox) =>
      json<Snapshot>(
        await posted(`${workspaces(workspace)}/initialize`, { outbox }),
      ),

    submit: async (workspace, request, { keepalive = false } = {}) =>
      json<Response>(
        await posted(`${workspaces(workspace)}/transactions`, request, {
          keepalive,
        }),
      ),

    cleared: async (workspace, transactions) => {
      await posted(`${workspaces(workspace)}/drafts/cleared`, { transactions });
    },

    bringRoomUpToFile: async (workspace, entry) =>
      (
        await json<{ base: Version | null }>(
          await posted(`${workspaces(workspace)}/rooms/${entry}`, {}),
        )
      ).base,

    warmRoom: async (workspace, entry) => {
      await posted(`${workspaces(workspace)}/rooms/${entry}/warm`, {});
    },

    roomStored: async (workspace, entry, version) => {
      await posted(`${workspaces(workspace)}/rooms/${entry}/stored`, { version });
    },

    handOver: async (workspace, entry, update) => {
      await send(`${workspaces(workspace)}/rooms/${entry}/updates`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: update as BodyInit,
      });
    },

    history: async (workspace, entry, asking) =>
      json<History>(
        await send(
          `${workspaces(workspace)}/entries/${entry}/history?${paged(asking)}`,
        ),
      ),

    content: async (workspace, entry, version) => {
      const query = version === undefined ? "" : `?content=${version}`;
      return payloadOf(
        await send(`${workspaces(workspace)}/entries/${entry}/content${query}`),
      );
    },

    uploadBytes: async (workspace, digest, bytes, mime) => {
      await send(`${workspaces(workspace)}/blobs/${digest}`, {
        method: "PUT",
        headers: {
          "content-type": mime,
          "content-length": String(bytes.byteLength),
        },
        body: bytes as BodyInit,
      });
    },

    follow: (workspace, token, reading) => {
      const controller = new AbortController();
      void (async () => {
        try {
          const response = await fetch(
            at(`${workspaces(workspace)}/stream?token=${token}`),
            { headers: await authorize(), signal: controller.signal },
          );
          if (!response.ok || response.body === null) {
            throw new Error(`stream: ${response.status}`);
          }
          reading.alive();
          await read(response.body, reading);
          reading.failed(new Error("stream ended"));
        } catch (reason) {
          if (!controller.signal.aborted) reading.failed(reason);
        }
      })();
      return { close: () => controller.abort() };
    },
  };
};
