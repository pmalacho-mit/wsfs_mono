<script lang="ts" module>
  import { Sweater } from "sweater-vest-suede";
  import { warming } from "$wsfs/warming";
  import type { Id, Metadata } from "$wsfs/contract";

  /** A workspace's entries, as `warming` is allowed to see them. */
  const workspace = (...entries: [Id, string | null][]) => {
    const map = new Map<Id, Metadata>();
    for (const [id, version] of entries)
      map.set(id, { id, type: "file", content_version: version } as never);
    return map;
  };

  const file = (id: Id, version: string): Metadata =>
    ({ id, type: "file", content_version: version }) as never;

  /** Fast enough that a test is a test rather than a wait. */
  const SETTLING = { idleMs: 10, maxWaitMs: 40 };

  const settled = (ms = 90) => new Promise((wake) => setTimeout(wake, ms));

  class Pocket {}
</script>

<Sweater config orientation="vertical" category="Warming" mode="serial" />

<Sweater
  name="a file written many times is fetched once, at the version it ended on"
  id="coalesces-a-backlog"
  body={async (harness) => {
    harness.set(new Pocket());

    const entries = workspace(["E-1", "V-1"]);
    const asked: (string | null)[] = [];
    const warm = warming({
      current: (id) => entries.get(id),
      fetch: async (entry) => void asked.push(entry.content_version ?? null),
      settling: SETTLING,
    });

    // A reconnect replaying 25 saves: each event moves the entry on and asks
    // for it to be warmed, exactly as `applied` does.
    for (let n = 1; n <= 25; n += 1) {
      entries.set("E-1", file("E-1", `V-${n}`));
      warm.wanted(entries.get("E-1"));
    }
    await settled();

    harness.note(`25 events → ${asked.length} fetch(es): ${asked.join(", ")}`);
    // THE INCIDENT, in one assertion. Twenty-four of those versions were
    // superseded before anyone could have read them; asking for them cost two
    // connections each and taught the client nothing.
    harness.expect(asked.length).toBe(1);
    harness.expect(asked[0]).toBe("V-25");

    warm.stop();
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="the version fetched is the one current when the request goes"
  id="resolves-late"
  body={async (harness) => {
    harness.set(new Pocket());

    const entries = workspace(["E-1", "V-1"]);
    const asked: (string | null)[] = [];
    const warm = warming({
      current: (id) => entries.get(id),
      fetch: async (entry) => void asked.push(entry.content_version ?? null),
      settling: SETTLING,
    });

    // Asked for while it held V-1, moved on before the debounce elapses.
    warm.wanted(entries.get("E-1"));
    entries.set("E-1", file("E-1", "V-9"));
    await settled();

    harness.note(`asked while V-1, fetched ${asked[0]}`);
    // Capturing the entry at `wanted` time would fetch V-1 -- a version that
    // is already wrong, and a second fetch would then be needed for V-9.
    harness.expect(asked).toEqual(["V-9"]);

    warm.stop();
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="opening a workspace does not open a hundred requests"
  id="bounded-fan-out"
  body={async (harness) => {
    harness.set(new Pocket());

    const many: [Id, string][] = [];
    for (let n = 0; n < 60; n += 1) many.push([`E-${n}` as Id, "V-1"]);
    const entries = workspace(...many);

    let running = 0;
    let most = 0;
    let done = 0;
    const release: (() => void)[] = [];
    const warm = warming({
      current: (id) => entries.get(id),
      fetch: () => {
        running += 1;
        most = Math.max(most, running);
        return new Promise<void>((go) =>
          release.push(() => (running -= 1, done += 1, go())),
        );
      },
      settling: SETTLING,
      atOnce: 6,
    });

    // What `snapshot.entries.forEach(readied)` does on every open.
    for (const entry of entries.values()) warm.wanted(entry);
    await settled();

    harness.note(`60 files → at most ${most} in flight`);
    harness.expect(most).toBe(6);

    // And the rest still go: the bound is a queue, not a cap on how many are
    // ever fetched.
    while (release.length > 0) {
      release.shift()!();
      await Promise.resolve();
    }
    await settled(30);
    harness.note(`finished ${done} of 60`);
    harness.expect(done > 6).toBe(true);

    warm.stop();
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="an entry that is gone by the time the burst settles is not asked for"
  id="skips-the-departed"
  body={async (harness) => {
    harness.set(new Pocket());

    const entries = workspace(["E-1", "V-1"], ["E-2", "V-1"]);
    const asked: Id[] = [];
    const warm = warming({
      current: (id) => entries.get(id),
      fetch: async (entry) => void asked.push(entry.id),
      settling: SETTLING,
    });

    warm.wanted(entries.get("E-1"));
    warm.wanted(entries.get("E-2"));
    entries.delete("E-1"); // deleted while the burst was settling
    await settled();

    harness.note(`asked for ${asked.join(", ")}`);
    // Ordinary rather than exceptional -- a file deleted during a replay is a
    // thing that happens, and there is nothing left to warm.
    harness.expect(asked).toEqual(["E-2"]);

    warm.stop();
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="folders are not files and hold no content"
  id="files-only"
  body={async (harness) => {
    harness.set(new Pocket());

    const asked: Id[] = [];
    const folder = { id: "F-1", type: "folder", content_version: null } as never;
    const warm = warming({
      current: () => folder,
      fetch: async (entry) => void asked.push(entry.id),
      settling: SETTLING,
    });

    warm.wanted(folder);
    await settled();

    harness.expect(asked).toEqual([]);
    warm.stop();
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="a fetch that fails does not stop the ones behind it"
  id="failure-is-not-fatal"
  body={async (harness) => {
    harness.set(new Pocket());

    const entries = workspace(["E-1", "V-1"], ["E-2", "V-1"], ["E-3", "V-1"]);
    const asked: Id[] = [];
    const warm = warming({
      current: (id) => entries.get(id),
      fetch: async (entry) => {
        asked.push(entry.id);
        if (entry.id === "E-1") throw new Error("503");
      },
      settling: SETTLING,
      atOnce: 1,
    });

    // Counted, because the queue drains either way -- the slot is released in
    // a `finally`. What a swallowed rejection actually buys is this: warming
    // is work nobody asked for, so a file the server would not hand over must
    // not surface as an error in the page that never wanted it.
    const loose: PromiseRejectionEvent[] = [];
    const noticed = (event: PromiseRejectionEvent) => loose.push(event);
    window.addEventListener("unhandledrejection", noticed);

    try {
      for (const entry of entries.values()) warm.wanted(entry);
      await settled();

      harness.note(`asked for ${asked.join(", ")}, ${loose.length} loose rejection(s)`);
      harness.expect(asked.sort()).toEqual(["E-1", "E-2", "E-3"]);
      harness.expect(loose.length).toBe(0);
    } finally {
      window.removeEventListener("unhandledrejection", noticed);
      warm.stop();
    }
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="settling now is not waiting"
  id="settle-flushes"
  body={async (harness) => {
    harness.set(new Pocket());

    const entries = workspace(["E-1", "V-4"]);
    const asked: (string | null)[] = [];
    const warm = warming({
      current: (id) => entries.get(id),
      fetch: async (entry) => void asked.push(entry.content_version ?? null),
      settling: { idleMs: 10_000, maxWaitMs: 20_000 },
    });

    warm.wanted(entries.get("E-1"));
    harness.expect(asked).toEqual([]);

    warm.settle();
    await Promise.resolve();
    harness.note(`after settle → ${asked.join(", ")}`);
    harness.expect(asked).toEqual(["V-4"]);

    warm.stop();
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="warming is not flushed when the tab goes away"
  id="no-flush-on-hide"
  body={async (harness) => {
    harness.set(new Pocket());

    const entries = workspace(["E-1", "V-1"], ["E-2", "V-1"]);
    const asked: Id[] = [];
    const warm = warming({
      current: (id) => entries.get(id),
      fetch: async (entry) => void asked.push(entry.id),
      settling: { idleMs: 10_000, maxWaitMs: 20_000 },
    });

    warm.wanted(entries.get("E-1"));
    warm.wanted(entries.get("E-2"));

    // What a debouncer does for a SAVE -- get it out before the tab dies --
    // is backwards for warming: a burst of requests for content nobody is
    // going to read, fired at the moment the reader left.
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    document.dispatchEvent(new Event("visibilitychange"));
    await settled(60);

    harness.note(`after pagehide, asked for ${JSON.stringify(asked)}`);
    harness.expect(asked).toEqual([]);
    warm.stop();
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="asking after the workspace stopped is ignored, not an error"
  id="wanted-after-stop"
  body={async (harness) => {
    harness.set(new Pocket());

    const entries = workspace(["E-1", "V-1"]);
    const warm = warming({
      current: (id) => entries.get(id),
      fetch: async () => {},
      settling: SETTLING,
    });
    warm.stop();

    // A stopped workspace still has a stream coming down, and it may announce
    // one more entry on the way. The debouncer throws once disposed, so
    // without the guard that lands as an error nobody can do anything about.
    let threw: unknown;
    try {
      warm.wanted(entries.get("E-1"));
    } catch (error) {
      threw = error;
    }
    harness.note(`threw: ${threw === undefined ? "no" : String(threw)}`);
    harness.expect(threw).toBe(undefined);
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="the concurrency bound holds even when a caller arrives mid-handover"
  id="bound-is-a-bound"
  body={async (harness) => {
    harness.set(new Pocket());

    const entries = workspace(["E-1", "V-1"], ["E-2", "V-1"], ["E-3", "V-1"]);
    let running = 0;
    let most = 0;
    const release: (() => void)[] = [];
    const warm = warming({
      current: (id) => entries.get(id),
      fetch: () => {
        running += 1;
        most = Math.max(most, running);
        return new Promise<void>((go) => release.push(() => (running -= 1, go())));
      },
      settling: SETTLING,
      atOnce: 1,
    });

    warm.wanted(entries.get("E-1"));
    warm.wanted(entries.get("E-2"));
    await settled(60);
    // A third arrives exactly as the first finishes: the slot must go to the
    // one already waiting, not to both.
    release.shift()!();
    warm.wanted(entries.get("E-3"));
    await settled(60);

    harness.note(`at most ${most} in flight against a limit of 1`);
    harness.expect(most).toBe(1);
    while (release.length > 0) release.shift()!();
    warm.stop();
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>
