<script lang="ts">
  /**
   * The sweep against a real IndexedDB, which is the only place two things
   * can be checked: that the store still opens after its version changed, and
   * that a payload nothing names is actually collected rather than merely
   * classified as collectable.
   *
   * The judgement itself is unit-tested in `tests/frontend/reclaim.test.ts`;
   * what a browser adds is the store.
   */
  import { Sweater } from "sweater-vest-suede";
  import { persistenceMechanism, mint, type Keeping } from "$wsfs";

  class Pocket {
    said = $state("");
  }
</script>

<Sweater config category="Reclaim" mode="serial" />

<Sweater
  name="opens a store whose version has moved on"
  body={async (harness: any) => {
    const pocket = harness.set(new Pocket());
    const held: Keeping = await persistenceMechanism(mint());
    pocket.said = `restored ${held.restored.entries.length}`;
    harness.expect(held.restored.entries).toEqual([]);
    /** And a second open, which is the one a version bump can hang. */
    const again = await persistenceMechanism(mint());
    harness.expect(again.reclamation()).toEqual({ phase: "idle" });
  }}
>
  {#snippet vest(pocket: Pocket)}
    <pre>{pocket.said}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="collects a payload that no queued row names"
  body={async (harness: any) => {
    const pocket = harness.set(new Pocket());
    const workspace = mint();
    const held = await persistenceMechanism(workspace);

    /**
     * Stored and never captured, which is exactly what a tab dying between
     * the payload and the row that names it leaves behind. Nothing else in
     * this client has ever collected one.
     */
    const digest = await held.bytes.put("garbage nobody claims\n");
    harness.expect(await held.bytes.text(digest)).toContain("garbage");

    /**
     * The sweep only takes bytes older than it, so this waits rather than
     * pretending: the guard is what makes it safe beside another tab.
     */
    await new Promise((carry) => setTimeout(carry, 30));
    const found = await held.reclaim();
    pocket.said = JSON.stringify(found);

    harness.expect(await held.bytes.text(digest)).toBeUndefined();
    harness.expect(["clear", "freed", "short"]).toContain(found.phase);
  }}
>
  {#snippet vest(pocket: Pocket)}
    <pre>{pocket.said}</pre>
  {/snippet}
</Sweater>
