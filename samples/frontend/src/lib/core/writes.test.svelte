<script lang="ts" module>
  import { Sweater } from "sweater-vest-suede";
  import { pump } from "$wsfs/writes";
  import { queue as makeQueue } from "$wsfs/outbox";
  import { inMemory } from "$wsfs/bytes";
  import type { Id, Submitted, Write } from "$wsfs/contract";

  const ENTRY = "ENTRY-1" as Id;

  const writing = (transaction: string, content: string, seen: string): Write =>
    ({
      op: "write",
      transaction,
      id: ENTRY,
      content_version: seen,
      content: { type: "text", content },
      draft: false,
    }) as never;

  /** A pump with the wire held open, so what it chose to send can be inspected. */
  const rigged = (landed?: () => Promise<unknown> | undefined) => {
    const queue = makeQueue();
    const wire: Submitted[] = [];
    const flight = pump({
      queue,
      bytes: inMemory(),
      send: async (request) => {
        wire.push(request);
        return { rejected: false, draft: false } as never;
      },
      announced: () => {},
      remembered: () => {},
      token: () => null,
      unsound: () => {},
      landed,
    });
    return { queue, wire, flight };
  };

  const settle = (ms = 40) => new Promise((wake) => setTimeout(wake, ms));

  class Pocket {}
</script>

<Sweater config orientation="vertical" category="Write pump" mode="serial" />

<Sweater
  name="a write waits for the entry's create before it goes"
  id="waits-for-create"
  body={async (harness) => {
    harness.set(new Pocket());

    let created: () => void = () => {};
    const creating = new Promise<void>((done) => (created = done));
    const { wire, flight } = rigged(() => creating);

    void flight.write(ENTRY, writing("TX-1", "typed", "CREATE-TX"), "typed", "text/plain");
    await settle();

    harness.note(`while the create is in flight, sent ${wire.length}`);
    // THE BUG THIS EXISTS FOR. Creates never go through this pump and the
    // chain it drains holds writes alone, so without the barrier this write
    // races its own create, arrives first, and is refused `no such entry` --
    // taking the text somebody typed with it.
    harness.expect(wire.length).toBe(0);

    created();
    await settle();

    harness.note(`once the create landed, sent ${wire.length}`);
    harness.expect(wire.length).toBe(1);
    harness.expect((wire[0] as any).transaction).toBe("TX-1");
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="a write held back for a create is already in the outbox"
  id="held-back-is-still-kept"
  body={async (harness) => {
    harness.set(new Pocket());

    const never = new Promise<void>(() => {}); // a create that never answers
    const { queue, wire, flight } = rigged(() => never);

    void flight.write(ENTRY, writing("TX-1", "typed", "CREATE-TX"), "typed", "text/plain");
    await settle();

    const held = queue.entries().map((item) => item.request.transaction);
    harness.note(`sent ${wire.length}, queued ${JSON.stringify(held)}`);

    // WHY THE BARRIER IS AT THE SEND AND NOT THE CAPTURE. Nothing is on the
    // wire, but the work is written down -- so a tab closed right here comes
    // back and Initialize replays it. Holding the write before the capture
    // would trade a refused write for a vanished one.
    harness.expect(wire.length).toBe(0);
    harness.expect(held).toEqual(["TX-1"]);
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="a create that was refused does not strand the writes behind it"
  id="refused-create-still-drains"
  body={async (harness) => {
    harness.set(new Pocket());

    const refused = Promise.reject(new Error("create refused"));
    refused.catch(() => undefined); // the barrier folds this away; keep node quiet
    const { wire, flight } = rigged(() => refused);

    void flight.write(ENTRY, writing("TX-1", "typed", "CREATE-TX"), "typed", "text/plain");
    await settle();

    harness.note(`after a failed create, sent ${wire.length}`);
    // The write goes and is refused in its turn, which is an answer the caller
    // gets. Waiting for ever on a create that will never land would be the
    // one outcome with nothing to report.
    harness.expect(wire.length).toBe(1);
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="with nothing to wait for, a write goes straight out"
  id="no-barrier-no-delay"
  body={async (harness) => {
    harness.set(new Pocket());

    const { wire, flight } = rigged(() => undefined);
    void flight.write(ENTRY, writing("TX-1", "typed", "SEEN-1"), "typed", "text/plain");
    await settle();

    harness.expect(wire.length).toBe(1);
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>
