<script lang="ts" module>
  import { Sweater } from "../../../../../sweater-vest-suede";
  import { http } from "../transport";
  import { forget, stash, stashed } from "../stash";
  import { anythingUnsaved, forgetAll, hold, release } from "../unsaved";
  import type { Submitted } from "../contract";

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
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
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
