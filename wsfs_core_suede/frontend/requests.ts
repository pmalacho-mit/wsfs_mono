/**
 * Requests to the host this client is mounted against.
 *
 * ONE DOOR, ONE BASE URL, ONE AUTH STORY. The room routes were bare `fetch`
 * calls to a path built by hand once, which is how they went on calling routes
 * that had moved -- and, once found, how they went on calling them without the
 * caller's authorisation. This is that lesson, made reusable: a package
 * mounting its own routes over this host's prefix builds them from here rather
 * than from a second copy of the same four lines.
 *
 * Nothing here knows a route. What it knows is where the router is and how to
 * authenticate, because both belong to whoever mounted it.
 */
export type Authorized = () => HeadersInit | Promise<HeadersInit>;

/** A refusal is an answer, not a failure -- the caller reads its reason. */
const REFUSED = 409;

export type Requests = {
  /** `/workspaces/{id}`, so a route reads as the path it is. */
  workspaces: (workspace: string) => string;
  send: (path: string, init?: RequestInit) => Promise<Response>;
  posted: (path: string, body: unknown, init?: RequestInit) => Promise<Response>;
  json: <T>(response: Response) => Promise<T>;
};

export const requesting = (base: string, authorize: Authorized): Requests => {
  const at = (path: string) => `${base.replace(/\/$/, "")}${path}`;

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

  return {
    workspaces: (workspace) => `/workspaces/${workspace}`,
    send,
    posted: (path, body, init = {}) =>
      send(path, {
        ...init,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    json: async <T>(response: Response) => (await response.json()) as T,
  };
};

/**
 * One `data:` line at a time, until the stream says it is done.
 *
 * Shared because every SSE response this system serves is read the same way,
 * and a second reader is a second place for the frame-splitting to be subtly
 * wrong. `ends` is what stops it: the event stream never ends, an answer does.
 */
export async function* lines<T>(
  response: Response,
  ends: (said: T) => boolean,
): AsyncIterable<T> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    pending += decoder.decode(value, { stream: true });
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      const said = JSON.parse(part.slice("data: ".length)) as T;
      yield said;
      if (!ends(said)) continue;
      /**
       * Read no further once it has ended. Nothing follows it, and holding
       * the body open would hold a connection for nothing.
       */
      await reader.cancel().catch(() => undefined);
      return;
    }
  }
}

/** The query a paged read asks with, and the only place it is spelled. */
export const paged = (asking: { before?: string; limit?: number }) => {
  const asked = new URLSearchParams();
  if (asking.before !== undefined) asked.set("before", asking.before);
  if (asking.limit !== undefined) asked.set("limit", String(asking.limit));
  return asked.toString();
};
