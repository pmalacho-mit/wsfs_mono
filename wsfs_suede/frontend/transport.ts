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
  Answering,
  Asked,
  Asking,
  Judged,
  Judging,
  Transcript,
  Accepted,
  Detected,
  Recorded,
} from "./contract";

export type Authorized = () => HeadersInit | Promise<HeadersInit>;

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
  store: (
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
  settleRoom: (workspace: Id, entry: Id) => Promise<Version | null>;
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
  /** Put a question to the tutor, and be told where to hear the answer. */
  ask: (workspace: Id, asking: Asking) => Promise<Asked>;
  /**
   * The answer, delta by delta, until it ends.
   *
   * An async iterator rather than a subscription, because unlike the event
   * stream this one ENDS, and a caller wants to await the end of it. Read with
   * `fetch` for the same reason the event stream is -- see `read` below -- and
   * for one more: `EventSource` reconnects on its own, and a reconnect here
   * would replay an answer somebody has already read.
   */
  hear: (workspace: Id, token: string) => AsyncIterable<Answering>;
  /** Whether a program has moved toward its goal since a few minutes ago. */
  progress: (workspace: Id, asking: Judging) => Promise<Judged>;
  /** This person's conversation here, newest first. */
  conversation: (
    workspace: Id,
    asking: { before?: string; limit?: number },
  ) => Promise<Transcript>;
  /**
   * The study's three write-only routes.
   *
   * POSTED AND FORGOTTEN. Everything else on this transport is somebody's
   * work and is retried until it lands; these are a study's observations, and
   * the trade is the other way round -- see `study.py`. The promises still
   * reject, so a caller that wants to know can look; nothing in this codebase
   * does anything but ignore them.
   *
   * `keepalive` is for the last flush of a window, which happens as a page is
   * going away: an ordinary fetch is cancelled with the document, and ten
   * minutes of recording would be lost at the last hurdle.
   */
  detected: (workspace: Id, told: Detected) => Promise<void>;
  accepted: (workspace: Id, told: Accepted) => Promise<void>;
  activity: (
    workspace: Id,
    told: Recorded,
    options?: { keepalive?: boolean },
  ) => Promise<void>;
};

const REFUSED = 409;

const json = async <T>(response: Response_) => (await response.json()) as T;

type Response_ = globalThis.Response;

const held = async (response: Response_): Promise<Payload> => {
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
  const at = (path: string) => `${base.replace(/\/$/, "")}${path}`;
  const workspaces = (workspace: Id) => `/workspaces/${workspace}`;

  const send = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(at(path), {
      ...init,
      headers: { ...(await authorize()), ...(init.headers ?? {}) },
    });
    if (!response.ok && response.status !== REFUSED) {
      throw new Error(`${init.method ?? "GET"} ${path}: ${response.status}`);
    }
    return response;
  };

  const posted = (path: string, body: unknown, init: RequestInit = {}) =>
    send(path, {
      ...init,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

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

    settleRoom: async (workspace, entry) =>
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

    ask: async (workspace, asking) =>
      json<Asked>(await posted(`${workspaces(workspace)}/chat`, asking)),

    hear: async function* (workspace, token) {
      const response = await send(
        `${workspaces(workspace)}/chat/stream?token=${encodeURIComponent(token)}`,
      );
      if (response.body === null) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const said = JSON.parse(line.slice("data: ".length)) as Answering;
          yield said;
          /**
           * Read no further once it has ended. Nothing follows it, and
           * holding the body open would hold a connection for nothing.
           */
          if (said.type === "ended") {
            await reader.cancel().catch(() => undefined);
            return;
          }
        }
      }
    },

    progress: async (workspace, asking) =>
      json<Judged>(await posted(`${workspaces(workspace)}/progress`, asking)),

    detected: async (workspace, told) => {
      await posted(`${workspaces(workspace)}/study/episodes`, told);
    },

    accepted: async (workspace, told) => {
      await posted(`${workspaces(workspace)}/study/offers`, told);
    },

    activity: async (workspace, told, { keepalive = false } = {}) => {
      await posted(`${workspaces(workspace)}/study/activity`, told, {
        keepalive,
      });
    },

    conversation: async (workspace, { before, limit }) => {
      const asked = new URLSearchParams();
      if (before !== undefined) asked.set("before", before);
      if (limit !== undefined) asked.set("limit", String(limit));
      return json<Transcript>(
        await send(`${workspaces(workspace)}/chat?${asked.toString()}`),
      );
    },

    history: async (workspace, entry, { before, limit }) => {
      const asked = new URLSearchParams();
      if (before !== undefined) asked.set("before", before);
      if (limit !== undefined) asked.set("limit", String(limit));
      return json<History>(
        await send(
          `${workspaces(workspace)}/entries/${entry}/history?${asked.toString()}`,
        ),
      );
    },

    content: async (workspace, entry, version) => {
      const query = version === undefined ? "" : `?content=${version}`;
      return held(
        await send(`${workspaces(workspace)}/entries/${entry}/content${query}`),
      );
    },

    store: async (workspace, digest, bytes, mime) => {
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
