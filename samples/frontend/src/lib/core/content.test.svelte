<script lang="ts" module>
  import { Sweater } from "sweater-vest-suede";
  import { cache, type Payload } from "$wsfs/content";
  import type { Metadata } from "$wsfs/contract";

  const entry = (version: string | null) =>
    ({ id: "E-1", type: "file", content_version: version }) as unknown as Metadata;

  const text = (said: string): Payload => ({ kind: "text", text: said });

  class Pocket {}
</script>

<Sweater config orientation="vertical" category="Content cache" mode="serial" />

<Sweater
  name="a version that failed to arrive is asked for again"
  id="forgets-failures"
  body={async (harness) => {
    harness.set(new Pocket());

    let asked = 0;
    const held = cache(async () => {
      asked += 1;
      if (asked === 1) throw new Error("503");
      return text("the file");
    });

    const first = await held.read(entry("V-1")).catch((reason) => reason as Error);
    harness.note(`first read → ${first}`);
    harness.expect(first instanceof Error).toBe(true);

    // THE WHOLE POINT. Keeping the rejected promise under its version made one
    // refused request permanent: every later read was handed the same failure
    // and never reached the network, so a file stayed unreadable in this tab
    // until somebody reloaded the page.
    const second = await held.read(entry("V-1"));
    harness.note(`second read → ${JSON.stringify(second)}`);
    harness.expect(asked).toBe(2);
    harness.expect(second).toEqual(text("the file"));
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="many readers of one version still make one request"
  id="shares-in-flight"
  body={async (harness) => {
    harness.set(new Pocket());

    let asked = 0;
    let answer: (payload: Payload) => void = () => {};
    const held = cache(() => {
      asked += 1;
      return new Promise<Payload>((settle) => (answer = settle));
    });

    const readers = [held.read(entry("V-2")), held.read(entry("V-2")), held.read(entry("V-2"))];
    answer(text("shared"));
    const all = await Promise.all(readers);

    harness.note(`3 readers → ${asked} request(s)`);
    // Forgetting a failure must not have cost the deduplication that stops a
    // replayed backlog asking for the same version once per caller.
    harness.expect(asked).toBe(1);
    harness.expect(all.every((one) => one?.kind === "text")).toBe(true);
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>

<Sweater
  name="a version already in hand is answered without asking"
  id="still-caches"
  body={async (harness) => {
    harness.set(new Pocket());

    let asked = 0;
    const held = cache(async () => {
      asked += 1;
      return text("once");
    });

    await held.read(entry("V-3"));
    await held.read(entry("V-3"));
    await held.read(entry("V-3"));

    harness.note(`3 reads → ${asked} request(s)`);
    harness.expect(asked).toBe(1);
    harness.expect(held.holding(entry("V-3"))).toEqual(text("once"));
  }}
>
  {#snippet vest(_p: Pocket)}
    <div style="height: 1px"></div>
  {/snippet}
</Sweater>
