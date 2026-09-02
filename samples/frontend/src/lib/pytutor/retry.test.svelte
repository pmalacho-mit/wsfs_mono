<script lang="ts" module>
  /**
   * A study observation is posted once and forgotten.
   *
   * Here rather than beside core's transport tests because the route moved:
   * `study.activity` is this package's, mounted through core's `requesting`
   * door. The trade runs the other way round from everything else on that
   * door -- a lost observation costs a row in a study, and retrying costs a
   * server that is already refusing work -- so this route stays on the POST
   * default and never opts in.
   */
  import { Sweater } from "sweater-vest-suede";
  import { tutoring } from "$pytutor/tutoring";

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
    } catch {
      /** The rejection is the caller's to ignore, and it does. */
    }
  };

  class Pocket {
    said = $state("");
  }
</script>

<Sweater config category="pytutor/retry" mode="serial" />

<Sweater
  name="a study observation is posted once and forgotten"
  id="no-retry-study"
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { seen, restore } = alwaysBusy();
    try {
      const tutor = tutoring({ id: "WS-1" } as never, {
        base: "/wsfs",
        authorize: async () => ({}),
      });
      await caught(() => tutor.study.activity({ window: [] } as never));

      pocket.said = `sent ${seen.length} times`;
      harness.note(pocket.said);
      harness.expect(seen.length).toBe(1);
    } finally {
      restore();
    }
  }}
>
  {#snippet vest(pocket: Pocket)}
    <pre>{pocket.said}</pre>
  {/snippet}
</Sweater>
