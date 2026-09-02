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
import { jittered } from "./loop";

export type Authorized = () => HeadersInit | Promise<HeadersInit>;

/**
 * Get a token that works, having just been told the last one did not.
 *
 * Optional, and what it is for is the case `Authorized` cannot cover: a token
 * that looked live to the client and was refused anyway -- a clock adrift, a
 * signing key changed under a running server, a session ended somewhere else.
 * False means there is no getting one, and the refusal stands.
 */
export type Reauthorized = () => Promise<boolean>;

/** A refusal is an answer, not a failure -- the caller reads its reason. */
const REFUSED = 409;
const REFUSED_AUTH = 401;

/**
 * Statuses that mean "not now", as opposed to "not ever".
 *
 * 429 and 503 are a server declining work it could do -- the admission gate
 * in front of the connection pool answers 503 -- and 502/504 are a proxy
 * saying it never got an answer. 408 is a request that ran out of time.
 *
 * 500 IS DELIBERATELY ABSENT. It means the server broke, not that it is busy,
 * and the overwhelming majority of those are deterministic: sending the same
 * request twice more produces the same traceback twice more, three log lines
 * where one would have done, and no better outcome for anybody.
 */
const TRANSIENT = new Set([408, 425, 429, 502, 503, 504]);

/**
 * Methods safe to send again with no thought about what the first one did.
 *
 * A POST is not on this list and gets no retry unless its call site says so,
 * because most of the ones here happen to be replayable and one is not:
 * asking the tutor twice starts answering twice. Opting in per route is what
 * makes that a decision somebody made rather than one they inherited -- and a
 * route added later gets the safe behaviour by not thinking about it.
 */
const REPLAYABLE_BY_METHOD = new Set(["GET", "HEAD", "PUT"]);

export type Sending = RequestInit & {
  /**
   * Whether sending this again can do no harm beyond the sending.
   *
   * Defaults to what the method implies. Set it on a POST whose effect is
   * named by something the CLIENT minted -- a transaction id, a content hash,
   * an update carrying its own identity -- because the server records that
   * unchanged and a second copy lands on the same thing as the first.
   */
  replayable?: boolean;
};

/** Said at the call sites that mean it, so the reason sits beside the route. */
export const REPLAYABLE = { replayable: true } as const;

export type Retrying = {
  /** Requests sent, including the first. */
  attempts: number;
  minDelayMs: number;
  maxDelayMs: number;
};

/**
 * Deliberately shorter than `loop.ts`'s ladder. That backoff is for a stream
 * nobody is waiting on and can afford to reach thirty seconds. This one runs
 * inside a call somebody made -- a file being opened, a save going out -- so
 * the whole ladder has to fit inside the time a person will sit looking at a
 * spinner. Three retries at 250/500/1000ms is about a second and a half.
 */
export const RETRYING: Retrying = {
  attempts: 4,
  minDelayMs: 250,
  maxDelayMs: 4_000,
};

const sleep = (ms: number) => new Promise<void>((wake) => setTimeout(wake, ms));

const stopped = (signal?: AbortSignal | null) => signal?.aborted === true;

/**
 * How long the server asked to be left alone, if it said.
 *
 * Both spellings the header allows: seconds, and an HTTP date. A server that
 * has bothered to say knows more about when it will be ready than any local
 * guess does, so this wins over the backoff whenever it is longer.
 */
const askedFor = (response: Response | undefined) => {
  const said = response?.headers.get("retry-after");
  if (!said) return undefined;
  const seconds = Number(said);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const when = Date.parse(said);
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
};

export type Requests = {
  /** `/workspaces/{id}`, so a route reads as the path it is. */
  workspaces: (workspace: string) => string;
  send: (path: string, init?: Sending) => Promise<Response>;
  posted: (path: string, body: unknown, init?: Sending) => Promise<Response>;
  json: <T>(response: Response) => Promise<T>;
};

export const requesting = (
  base: string,
  authorize: Authorized,
  reauthorize?: Reauthorized,
  retrying: Retrying = RETRYING,
): Requests => {
  const at = (path: string) => `${base.replace(/\/$/, "")}${path}`;

  const once = async (path: string, init: RequestInit) =>
    fetch(at(path), {
      ...init,
      headers: { ...(await authorize()), ...(init.headers ?? {}) },
    });

  /**
   * A request, sent again if it was refused for its token or met a server
   * that was not ready for it.
   *
   * TWO RESENDS, FOR TWO DIFFERENT REASONS, and they compose rather than
   * share a budget.
   *
   * A 401 is resent once, whatever the method. That is safe for anything: a
   * request refused for its token was refused BEFORE it did anything, so the
   * second cannot repeat an effect the first had. Without it, a client whose
   * session had quietly lapsed spent its loop presenting the same dead token
   * until somebody reloaded the page.
   *
   * A transient failure -- no answer at all, or one of `TRANSIENT` -- is
   * resent up to `retrying.attempts`, backing off and JITTERED, and only if
   * the request is replayable. The jitter is the point rather than a detail:
   * a server sheds load when many clients want it at once, so a fixed delay
   * would gather exactly those clients into a second wave the same size as
   * the first. Spreading them is what turns shedding into recovery instead of
   * into a slower oscillation.
   *
   * A response that is merely a refusal the CALLER should see -- a 409, a
   * 403, a 404 -- is not a failure of the request and is handed back or
   * thrown immediately. Retrying those would only delay the answer.
   */
  const send = async (path: string, { replayable, ...init }: Sending = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const mayReplay = replayable ?? REPLAYABLE_BY_METHOD.has(method);
    const refused = () =>
      new Error(`${method} ${path}: ${status ?? "no answer"}`);

    let reauthorized = false;
    let sent = 0;
    let status: number | undefined;

    for (;;) {
      let response: Response | undefined;
      let broke: unknown;
      try {
        response = await once(path, init);
        status = response.status;
      } catch (reason) {
        // An abort is the caller changing its mind, not the server failing.
        if (stopped(init.signal)) throw reason;
        broke = reason;
        status = undefined;
      }

      if (response?.status === REFUSED_AUTH && !reauthorized) {
        reauthorized = true;
        if (await reauthorize?.()) continue; // outside the retry budget
      }
      if (response && (response.ok || response.status === REFUSED)) {
        return response;
      }
      if (response && !TRANSIENT.has(response.status)) throw refused();

      // Nothing will read this body. Cancelling it hands the connection back
      // now rather than whenever the collector gets to it, which matters most
      // in exactly the case that produced it: a server short of them.
      void response?.body?.cancel().catch(() => undefined);

      sent += 1;
      if (!mayReplay || sent >= retrying.attempts || stopped(init.signal)) {
        throw response ? refused() : broke;
      }

      const backoff = Math.min(
        retrying.minDelayMs * 2 ** (sent - 1),
        retrying.maxDelayMs,
      );
      /**
       * The server's number is a FLOOR, and the jitter goes above it.
       *
       * Jittering the way the backoff is jittered would return 50-100% of it,
       * so `Retry-After: 2` would be honoured by coming back after one second
       * -- which is not honouring it, and the gate that sent it is still
       * draining. Spreading is still wanted, so it is added rather than
       * multiplied: the wait is never shorter than asked and never identical
       * across clients.
       */
      const told = askedFor(response);
      await sleep(
        told === undefined
          ? jittered(backoff)
          : told + Math.random() * Math.min(told, retrying.maxDelayMs),
      );
      if (stopped(init.signal)) throw response ? refused() : broke;
    }
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
