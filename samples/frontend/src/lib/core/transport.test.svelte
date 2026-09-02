<script lang="ts" module>
  import { Sweater } from "sweater-vest-suede";
  import { http } from "$wsfs/transport";
  import { forget, stash, stashed } from "$wsfs/stash";
  import { anythingUnsaved, forgetAll, hold, release } from "$wsfs/unsaved";
  import type { Submitted } from "$wsfs/contract";

  /**
   * `fetch`, replaced and remembered.
   *
   * The whole of what is under test here is one flag reaching one call, and
   * the only place to see it is the request the transport actually makes.
   */
  type Seen = { url: string; init: RequestInit };

  const recording = async <T>(act: (seen: Seen[]) => Promise<T>) => {
    const seen: Seen[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((url: string, init: RequestInit = {}) => {
      seen.push({ url: String(url), init });
      return Promise.resolve(
        new Response(JSON.stringify({ rejected: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as never;
    try {
      await act(seen);
    } finally {
      globalThis.fetch = original;
    }
    return seen;
  };

  /**
   * `fetch`, answering from a script.
   *
   * Each entry is what the NEXT call gets: a status, or a thrown failure
   * standing in for a request that never reached a server at all. The last
   * entry repeats, so a test says only as much as it cares about.
   */
  type Answer = { status: number; headers?: Record<string, string> } | "unreachable";

  const answering = (...script: Answer[]) => {
    const seen: { url: string; init: RequestInit }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((url: string, init: RequestInit = {}) => {
      const answer = script[Math.min(seen.length, script.length - 1)]!;
      seen.push({ url: String(url), init });
      if (answer === "unreachable") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ rejected: false, content: "hi" }), {
          status: answer.status,
          headers: { "content-type": "application/json", ...(answer.headers ?? {}) },
        }),
      );
    }) as never;
    return { seen, restore: () => void (globalThis.fetch = original) };
  };

  /** Short enough that a whole ladder fits in a test rather than a coffee break. */
  const IMPATIENT = { attempts: 4, minDelayMs: 1, maxDelayMs: 4 };

  const caught = async (act: () => Promise<unknown>) => {
    try {
      await act();
      return undefined;
    } catch (reason) {
      return reason;
    }
  };

  const write = (): Submitted =>
    ({
      op: "write",
      transaction: "TX-1",
      id: "ENTRY-1",
      content_version: "V-1",
      content: { type: "text", content: "print('hi')" },
      draft: false,
    }) as never;

  class Pocket {}
</script>

<Sweater config orientation="vertical" category="Transport" mode="serial" />

<Sweater
  name="an ordinary write is an ordinary request"
  id="submit-plain"
  body={async (harness) => {
    harness.set(new Pocket());
    const transport = http("/wsfs", async () => ({}));

    const seen = await recording(async () => {
      await transport.submit("WS-1", write());
    });

    harness.note(`keepalive → ${JSON.stringify(seen[0]?.init.keepalive)}`);
    harness.expect(seen.length).toBe(1);
    harness.expect(seen[0]!.url).toContain("/workspaces/WS-1/transactions");
    // Absent or false, either way: the normal path must not spend the 64KB
    // budget the browser shares between every keepalive request on the page.
    harness.expect(seen[0]!.init.keepalive ?? false).toBe(false);
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="a rescue write is made to outlive the document"
  id="submit-keepalive"
  body={async (harness) => {
    harness.set(new Pocket());
    const transport = http("/wsfs", async () => ({}));

    const seen = await recording(async () => {
      await transport.submit("WS-1", write(), { keepalive: true });
    });

    harness.note(`keepalive → ${JSON.stringify(seen[0]?.init.keepalive)}`);
    harness.capture("png");

    // Without this the last write of a session is cancelled along with the
    // page that made it, which is how typing into a new file and reloading
    // ended with an empty file and no version to recover.
    harness.expect(seen.length).toBe(1);
    harness.expect(seen[0]!.init.keepalive).toBe(true);
    harness.expect(String(seen[0]!.init.body)).toContain("print('hi')");
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="a note is written where writing it down cannot fail"
  id="stash-roundtrip"
  body={async (harness) => {
    harness.set(new Pocket());
    for (const key of Object.keys(localStorage))
      if (key.startsWith("wsfs:stash:")) localStorage.removeItem(key);

    stash("WS-A", { entry: "E-1", basis: "V-1", text: "typed", at: Date.now() });
    stash("WS-A", { entry: "E-2", basis: "V-9", text: "also", at: Date.now() });
    // A different workspace's notes are not this workspace's business.
    stash("WS-B", { entry: "E-3", basis: "V-1", text: "elsewhere", at: Date.now() });

    const mine = stashed("WS-A");
    harness.note(`WS-A → ${mine.map((one) => one.entry).join(", ")}`);
    harness.expect(mine.map((one) => one.entry).sort()).toEqual(["E-1", "E-2"]);
    harness.expect(mine.find((one) => one.entry === "E-1")?.text).toBe("typed");
    harness.expect(stashed("WS-B").length).toBe(1);

    forget("WS-A", "E-1");
    harness.expect(stashed("WS-A").map((one) => one.entry)).toEqual(["E-2"]);

    forget("WS-A", "E-2");
    forget("WS-B", "E-3");
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="a note written by another version is dropped, not thrown over"
  id="stash-malformed"
  body={async (harness) => {
    harness.set(new Pocket());
    localStorage.setItem("wsfs:stash:WS-C:E-1", "{ not json");
    localStorage.setItem("wsfs:stash:WS-C:E-2", JSON.stringify({ nope: 1 }));
    stash("WS-C", { entry: "E-3", basis: "V-1", text: "good", at: Date.now() });

    const found = stashed("WS-C");
    harness.note(`kept → ${found.map((one) => one.entry).join(", ")}`);

    // The one good note survives; refusing to open the workspace over the
    // other two would turn a lost paragraph into a lost session.
    harness.expect(found.map((one) => one.entry)).toEqual(["E-3"]);
    harness.expect(localStorage.getItem("wsfs:stash:WS-C:E-1")).toBe(null);

    forget("WS-C", "E-3");
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="the leaving prompt is registered only while work is at risk"
  id="unsaved-listener"
  body={async (harness) => {
    harness.set(new Pocket());
    forgetAll();

    // Counted, so the listener's presence can be asserted rather than guessed
    // at -- `beforeunload` cannot be observed any other way.
    let listening = 0;
    const add = window.addEventListener.bind(window) as (
      ...args: never[]
    ) => void;
    const remove = window.removeEventListener.bind(window) as (
      ...args: never[]
    ) => void;
    window.addEventListener = ((type: string, ...rest: never[]) => {
      if (type === "beforeunload") listening += 1;
      return add(type as never, ...rest);
    }) as never;
    window.removeEventListener = ((type: string, ...rest: never[]) => {
      if (type === "beforeunload") listening -= 1;
      return remove(type as never, ...rest);
    }) as never;

    try {
      harness.expect(anythingUnsaved()).toBe(false);
      harness.expect(listening).toBe(0);

      hold("FILE-1");
      harness.expect(anythingUnsaved()).toBe(true);
      harness.expect(listening).toBe(1);

      // Two dirty files are ONE prompt, and the second going clean must not
      // take it away from the first.
      hold("FILE-2");
      release("FILE-2");
      harness.note(`one file still dirty → listening ${listening}`);
      harness.expect(listening).toBe(1);

      release("FILE-1");
      harness.note(`nothing dirty → listening ${listening}`);
      // Back off the moment there is nothing to lose, so the page is
      // back/forward-cacheable again.
      harness.expect(anythingUnsaved()).toBe(false);
      harness.expect(listening).toBe(0);
    } finally {
      window.addEventListener = add as never;
      window.removeEventListener = remove as never;
      forgetAll();
    }
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="a read the server was too busy for is asked again"
  id="retry-503"
  body={async (harness) => {
    harness.set(new Pocket());
    const { seen, restore } = answering(
      { status: 503, headers: { "retry-after": "0" } },
      { status: 503 },
      { status: 200 },
    );
    try {
      const transport = http("/wsfs", async () => ({}), undefined, IMPATIENT);
      const held = await transport.content("WS-1", "E-1", "V-1");

      harness.note(`sent ${seen.length} times, then ${JSON.stringify(held)}`);
      // The admission gate answers 503 while it drains. A client that gave up
      // on the first one would show an empty file for a server that was busy
      // for a quarter of a second.
      harness.expect(seen.length).toBe(3);
      harness.expect(held.kind).toBe("text");
    } finally {
      restore();
    }
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="asking again has a limit"
  id="retry-bounded"
  body={async (harness) => {
    harness.set(new Pocket());
    const { seen, restore } = answering({ status: 503 });
    try {
      const transport = http("/wsfs", async () => ({}), undefined, IMPATIENT);
      const failure = await caught(() => transport.content("WS-1", "E-1", "V-1"));

      harness.note(`sent ${seen.length} times, then gave up: ${failure}`);
      // Four, not for ever. A server that is down stays down, and a client
      // that never stops asking is the load that keeps it that way.
      harness.expect(seen.length).toBe(IMPATIENT.attempts);
      harness.expect(failure instanceof Error).toBe(true);
    } finally {
      restore();
    }
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="a request that never reached a server is asked again"
  id="retry-offline"
  body={async (harness) => {
    harness.set(new Pocket());
    const { seen, restore } = answering("unreachable", "unreachable", { status: 200 });
    try {
      const transport = http("/wsfs", async () => ({}), undefined, IMPATIENT);
      await transport.content("WS-1", "E-1", "V-1");

      harness.note(`sent ${seen.length} times`);
      // A dropped connection is not an answer, and a tab that woke on a train
      // should not need a reload to read its own file.
      harness.expect(seen.length).toBe(3);
    } finally {
      restore();
    }
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="a write whose id the client minted is sent again"
  id="retry-replayable-post"
  body={async (harness) => {
    harness.set(new Pocket());
    const { seen, restore } = answering({ status: 503 }, { status: 200 });
    try {
      const transport = http("/wsfs", async () => ({}), undefined, IMPATIENT);
      await transport.submit("WS-1", write());

      harness.note(`sent ${seen.length} times`);
      // The transaction id came from here and the server records it unchanged,
      // so the second copy lands on the same write as the first.
      harness.expect(seen.length).toBe(2);
      harness.expect(seen[0]!.url).toContain("/transactions");
    } finally {
      restore();
    }
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>



<Sweater
  name="an answer the caller asked for is not second-guessed"
  id="no-retry-answers"
  body={async (harness) => {
    harness.set(new Pocket());
    for (const [status, expected] of [
      [409, "returned"],
      [403, "thrown"],
      [404, "thrown"],
      [500, "thrown"],
    ] as const) {
      const { seen, restore } = answering({ status });
      try {
        const transport = http("/wsfs", async () => ({}), undefined, IMPATIENT);
        const failure = await caught(() => transport.content("WS-1", "E-1", "V-1"));

        harness.note(`${status} → sent ${seen.length} time(s), ${expected}`);
        // A refusal is an answer. Only "not now" is worth asking twice, and a
        // 500 is the server broken rather than the server busy.
        harness.expect(seen.length).toBe(1);
        harness.expect(failure === undefined).toBe(status === 409);
      } finally {
        restore();
      }
    }
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="a lapsed token is refreshed without spending the retry budget"
  id="retry-401-then-503"
  body={async (harness) => {
    harness.set(new Pocket());
    const { seen, restore } = answering(
      { status: 401 },
      { status: 503 },
      { status: 200 },
    );
    try {
      let refreshed = 0;
      const transport = http(
        "/wsfs",
        async () => ({}),
        async () => (refreshed += 1) > 0,
        IMPATIENT,
      );
      await transport.content("WS-1", "E-1", "V-1");

      harness.note(`refreshed ${refreshed}×, sent ${seen.length}×`);
      // Three requests: the refused one, the one after re-authorising, and
      // the retry of the 503. The re-auth must not eat an attempt the busy
      // server still needs.
      harness.expect(refreshed).toBe(1);
      harness.expect(seen.length).toBe(3);
    } finally {
      restore();
    }
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="the server saying how long to wait is waited out"
  id="retry-after-honoured"
  body={async (harness) => {
    harness.set(new Pocket());
    const { seen, restore } = answering(
      { status: 503, headers: { "retry-after": "1" } },
      { status: 200 },
    );
    try {
      const transport = http("/wsfs", async () => ({}), undefined, {
        attempts: 3,
        minDelayMs: 1,
        maxDelayMs: 5_000,
      });
      const started = performance.now();
      await transport.content("WS-1", "E-1", "V-1");
      const waited = performance.now() - started;

      harness.note(`waited ${Math.round(waited)}ms for a 1s Retry-After`);
      // A FLOOR, not a suggestion. The backoff would have been 1ms, and
      // jittering the server's number the way the backoff is jittered would
      // have come back after half of it -- while the gate that sent it was
      // still draining. Never less than asked; spread out above it.
      harness.expect(seen.length).toBe(2);
      harness.expect(waited >= 1_000).toBe(true);
      harness.expect(waited < 2_500).toBe(true);
    } finally {
      restore();
    }
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="Initialize is not retried here, because the loop already retries it"
  id="initialize-not-replayed"
  body={async (harness) => {
    harness.set(new Pocket());
    const { seen, restore } = answering({ status: 503 });
    try {
      const transport = http("/wsfs", async () => ({}), undefined, IMPATIENT);
      const failure = await caught(() => transport.initialize("WS-1", []));

      harness.note(`sent ${seen.length} time(s), then ${failure}`);
      // `loop.ts` re-enters Initialize on every failure with its own 500ms to
      // 30s ladder. Retrying here too would put four Initializes on the wire
      // per loop cycle -- four copies of the whole outbox -- in the window a
      // shedding server can least afford them.
      harness.expect(seen.length).toBe(1);
      harness.expect(failure instanceof Error).toBe(true);
    } finally {
      restore();
    }
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>
