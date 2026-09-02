<script lang="ts" module>
  /**
   * The one POST on this host that must NOT be sent twice.
   *
   * It lives here rather than beside core's transport tests because the route
   * moved: `ask` is this package's, mounted through core's `requesting` door.
   * That door retries a request only when its call site says the request is
   * replayable, and a POST does not say so by default -- so this test is
   * really asking whether the default still protects a route that never opted
   * in. It would pass vacuously if somebody deleted `ask`; it fails loudly if
   * somebody makes POST retry by default.
   */
  import { Sweater } from "sweater-vest-suede";
  import { assistant } from "$assistant/assistant";

  /** Every call answered `503`, and every call remembered. */
  const alwaysBusy = () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((url: string) => {
      seen.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as never;
    return { seen, restore: () => void (globalThis.fetch = original) };
  };

  const caught = async (act: () => Promise<unknown>) => {
    try {
      await act();
      return undefined;
    } catch (reason) {
      return reason;
    }
  };

  class Pocket {
    said = $state("");
  }
</script>

<Sweater config category="assistant/retry" mode="serial" />

<Sweater
  name="a question to the tutor is asked once, however busy the server is"
  id="no-retry-ask"
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { seen, restore } = alwaysBusy();
    try {
      const tutor = assistant(
        { id: "WS-1", attached: () => [] } as never,
        { base: "/wsfs", authorize: async () => ({}) },
      );
      const failure = await caught(() =>
        tutor.ask({ question: "why?" } as never),
      );

      pocket.said = `sent ${seen.length} times`;
      harness.note(`${pocket.said}, then ${failure}`);
      /**
       * THE ONE POST THAT IS NOT REPLAYABLE. Sending it again starts a second
       * answer, and the person gets two tutors talking over each other.
       */
      harness.expect(seen.length).toBe(1);
      harness.expect(failure instanceof Error).toBe(true);
    } finally {
      restore();
    }
  }}
>
  {#snippet vest(pocket: Pocket)}
    <pre>{pocket.said}</pre>
  {/snippet}
</Sweater>
