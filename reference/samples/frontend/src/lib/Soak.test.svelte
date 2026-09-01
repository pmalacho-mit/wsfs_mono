<script lang="ts">
  /**
   * A long editing session, driven the way a person drives one, and then
   * asked the only question that matters: is anything missing.
   *
   * NOT A SCENARIO. The scenarios each pin one behaviour with one arrangement
   * they chose. This does the opposite: it picks its actions at random from
   * the ones a real session is made of -- typing, saving, losing the network,
   * losing the room, reloading the tab, restoring an old version -- and runs
   * hundreds of them. What it asserts is not that any particular thing
   * happened, but that after all of it:
   *
   *   1. the file holds what the last accepted write said it holds,
   *   2. every transaction this client ever got an answer for is one the
   *      server can still account for,
   *   3. nothing this client typed and was told was saved has gone.
   *
   * SEEDED, so a failure is a number somebody can put back in and watch
   * again. A soak test that cannot be replayed is a rumour.
   */
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import { Collaborator } from "./harness/collaboration";
  import { me } from "./harness/collaboration";
  import { project } from "./harness/testing.svelte";

  /**
   * Deterministic, and small on purpose: `Math.random()` would make every run
   * a different test and every failure unrepeatable.
   */
  const rolling = (seed: number) => {
    let held = seed >>> 0;
    return () => {
      held = (held * 1664525 + 1013904223) >>> 0;
      return held / 0x100000000;
    };
  };

  type Act = {
    what: string;
    /** What the file should say afterwards, if this changed it. */
    said?: string;
  };

  class Pocket {
    who = $state("");
    note = $state("");
    text = $state("");
    rounds = $state(0);
    log = $state<string[]>([]);
    verdict = $state("");
  }

  const wait = (ms: number) => new Promise((carry) => setTimeout(carry, ms));

  const until = async (
    what: string,
    ready: () => boolean | Promise<boolean>,
    within = 30_000,
    /** What was there instead, which is the only evidence a failure leaves. */
    seen?: () => string,
  ) => {
    const deadline = Date.now() + within;
    for (;;) {
      if (await ready()) return;
      if (Date.now() > deadline)
        throw new Error(
          `waited ${within}ms for ${what}${seen ? ` -- saw ${seen()}` : ""}`,
        );
      await wait(100);
    }
  };
</script>

<Sweater config category="Soak" orientation="vertical" mode="serial" />

<Sweater
  name="a long session of ordinary editing loses nothing"
  body={async (harness: any) => {
    const pocket: Pocket = harness.set(new Pocket());
    pocket.who = "one client, many rounds";

    const SEED = 13;
    const ROUNDS = 40;
    const roll = rolling(SEED);
    const pick = <T,>(from: T[]): T => from[Math.floor(roll() * from.length)]!;

    const id = await project("ada@example.com");
    let client = await Collaborator.opened(me(), id);
    harness.onAbort(() => client.dispose());

    const path = "soak.py";
    const made = client.workspace.create(path, "line 0\n");
    const entry = made.entry;
    await made.settled;

    /**
     * What this client believes the file says, and every transaction it was
     * ever told was accepted. The believed text only moves when the server
     * says a write landed -- a belief updated optimistically would agree with
     * the client by construction and prove nothing.
     */
    let believed = "line 0\n";
    const accepted: string[] = [made.transaction];
    const acted: Act[] = [];
    /** Work that reached nobody, and must still be recoverable. */
    const drafted: { transaction: string; says: string }[] = [];

    /**
     * Whether a document speaks for this file right now.
     *
     * Once one does, text reaches the file THROUGH it -- rule one -- and
     * writing around it is refused. A session moves in and out of that state
     * as panels open and close, so this soak has to as well.
     */
    const opened = () => client.rooms.get(entry) !== undefined;

    /** Ordinary typing, saved the way whatever is holding the file saves. */
    const typeAndSave = async (at: number): Promise<Act> => {
      const next = `${believed}line ${at}\n`;
      if (opened()) {
        client.type(entry, next);
        await until("the room to speak", () => client.speaks(entry), 30_000);
        const stored = await client.store(entry);
        if (stored.held)
          return { what: `typed line ${at}, kept: ${stored.why}` };
        believed = next;
        accepted.push(stored.transaction);
        return { what: `typed line ${at} into the document`, said: next };
      }
      const written = client.workspace.write(path, next);
      try {
        const answer = await written.settled;
        if (!answer.rejected) {
          believed = next;
          accepted.push(written.transaction);
          return { what: `typed line ${at}`, said: next };
        }
        return { what: `typed line ${at}, refused: ${answer.reason}` };
      } catch {
        /** The wire was down. Queued, and settled later or not at all. */
        return { what: `typed line ${at}, unsent` };
      }
    };

    /** Put the document down, which a person does by closing the tab. */
    const closeFile = async (): Promise<Act> => {
      if (!opened()) return { what: "nothing open to close" };
      await client.close(entry);
      return { what: "closed the file" };
    };

    /** The server goes away and comes back while the person keeps working. */
    const offlineSpell = async (at: number): Promise<Act> => {
      if (opened()) return { what: "a document holds this; not writing around it" };
      client.reachable(false);
      const next = `${believed}offline ${at}\n`;
      const written = client.workspace.write(path, next);
      void written.settled.catch(() => undefined);
      await wait(150);
      client.reachable(true);
      client.workspace.nudge();
      /**
       * Queued work leaves the outbox when the STREAM carries it, so this
       * waits for the file to actually say it rather than for the answer.
       */
      await until(`the offline write ${at} to land`, async () =>
        (await client.reads(entry)).includes(`offline ${at}`),
      );
      believed = next;
      accepted.push(written.transaction);
      return { what: `wrote ${at} with no server`, said: next };
    };

    /** The tab is closed and opened again, with the same storage under it. */
    const reload = async (): Promise<Act> => {
      await client.dispose();
      client = await Collaborator.opened(me(), id);
      harness.onAbort(() => client.dispose());
      await until("the workspace to come back", () =>
        client.workspace.entries().has(entry),
      );
      return { what: "reloaded the tab" };
    };

    /**
     * Two writes issued without waiting for the first.
     *
     * What somebody typing quickly actually does, and the case the write pump
     * exists for: both read the same token, so the second would lose a
     * compare-and-swap against the first if it were not chained behind it.
     */
    const race = async (at: number): Promise<Act> => {
      if (opened()) return { what: "a document holds this; not racing around it" };
      const first = `${believed}race ${at}a\n`;
      const second = `${first}race ${at}b\n`;
      const one = client.workspace.write(path, first);
      const two = client.workspace.write(path, second);
      const answers = await Promise.allSettled([one.settled, two.settled]);
      const landed = answers.every(
        (held) => held.status === "fulfilled" && !held.value.rejected,
      );
      if (!landed) return { what: `raced ${at}, one did not land` };
      believed = second;
      accepted.push(one.transaction, two.transaction);
      return { what: `raced two writes ${at}`, said: second };
    };

    /**
     * Typing with the room gone, which is what makes a draft.
     *
     * The work reached nobody, so it must not become the file -- and must
     * still be recoverable, which is the entire reason drafts exist.
     */
    const draftSpell = async (at: number): Promise<Act> => {
      await client.open(entry);
      await until("the room to carry the file", () =>
        client.text(entry).includes("line 0") || client.text(entry).length > 0,
      );
      client.goOffline(entry);
      client.type(entry, `${client.text(entry)}draft ${at}\n`);
      const kept = await client.store(entry);
      if (!kept.held) return { what: `draft ${at} was not held` };
      drafted.push({ transaction: kept.draft!, says: `draft ${at}` });

      /**
       * And then it stops being a draft, which is the design rather than a
       * surprise: coming back, the host carries what this document holds into
       * the room, and the next store writes it to the file. The draft was
       * never a copy to be discarded -- it was the same work, waiting.
       *
       * So what this client believes has to move too. An earlier version of
       * this test did not, and reported the draft's line as "in the file and
       * not expected" -- which was the soak being wrong and the product being
       * right, and is why the failure names lines rather than truncating two
       * strings.
       */
      await client.comeBack(entry);
      await until("the room to speak again", () => client.speaks(entry), 30_000);
      const stored = await client.store(entry);
      if (!stored.held) accepted.push(stored.transaction);
      believed = client.text(entry);
      return { what: `kept draft ${at}, then shared it`, said: believed };
    };

    /** Somebody asks for an older version back. */
    const restore = async (): Promise<Act> => {
      const { versions } = await client.workspace.history(entry, { limit: 10 });
      const older = versions.filter(
        (one) => one.standing === "applied" && one.kind === "text",
      );
      if (older.length < 2) return { what: "nothing old enough to restore" };
      const wanted = older[older.length - 1]!;
      const held = await client.workspace.at(entry, wanted.transaction);
      if (held.kind !== "text") return { what: "that version was not text" };
      const { settled } = await client.workspace.restore(
        entry,
        wanted.transaction,
      );
      const answer = await settled;
      if (answer.rejected) return { what: `restore refused: ${answer.reason}` };
      believed = held.text;
      return { what: "restored an older version", said: held.text };
    };

    for (let round = 0; round < ROUNDS; round += 1) {
      const act = pick([
        "type",
        "type",
        "type",
        "race",
        "offline",
        "draft",
        "reload",
        "restore",
        "close",
      ]);
      const done =
        act === "type"
          ? await typeAndSave(round)
          : act === "race"
            ? await race(round)
            : act === "offline"
              ? await offlineSpell(round)
              : act === "draft"
                ? await draftSpell(round)
                : act === "reload"
                  ? await reload()
                  : act === "close"
                    ? await closeFile()
                    : await restore();
      acted.push(done);
      pocket.rounds = round + 1;
      pocket.log = [...acted.slice(-6).map((one) => one.what)];

      /**
       * Checked EVERY round rather than once at the end. A soak test that
       * only looks afterwards can say something broke; one that looks as it
       * goes can say which round broke it.
       */
      if (done.said !== undefined) {
        await until(
          `the file to say what round ${round} wrote`,
          async () => (await client.reads(entry)) === done.said,
        );
      }
    }

    /**
     * 1. The file holds what the last accepted change said it holds.
     *
     * Reported as which LINES differ rather than as two truncated strings: a
     * soak's whole value is telling you what went missing, and "expected
     * 'line 0\nrace…' to be 'line 0\nrace…'" tells you nothing at all.
     */
    const finally_ = await client.reads(entry);
    if (finally_ !== believed) {
      const held = new Set(finally_.split("\n").filter(Boolean));
      const wanted_ = new Set(believed.split("\n").filter(Boolean));
      const missing = [...wanted_].filter((line) => !held.has(line));
      const extra = [...held].filter((line) => !wanted_.has(line));
      throw new Error(
        `the file and this client disagree -- missing from the file: ` +
          `${missing.join(" | ") || "(none)"}; in the file and not expected: ` +
          `${extra.join(" | ") || "(none)"}`,
      );
    }

    /**
     * 2. Everything answered is still accounted for. `unsettled` is the
     * client's own question -- of these transactions, which has the server
     * not written down -- and an empty answer is what makes a snapshot of
     * this session portable to anybody else.
     */
    await until(
      "every accepted transaction to be settled",
      () => client.workspace.unsettled(accepted).length === 0,
      60_000,
      () => {
        const loose = client.workspace.unsettled(accepted);
        const when = loose.map((one) => {
          const at = accepted.indexOf(one);
          return `${one.slice(-6)} (accepted ${at} of ${accepted.length})`;
        });
        return `${loose.length} still unsettled: ${when.join(", ")}`;
      },
    );

    /**
     * 3. Every draft is still readable, and says what was typed into it.
     *
     * A draft is work that reached NOBODY -- it is the only kind the server
     * cannot reconstruct from anything else, so "recorded and recoverable" is
     * the whole of what it promises.
     */
    for (const one of drafted) {
      const held = await client.workspace.at(entry, one.transaction);
      harness.expect(held.kind).toBe("text");
      harness.expect(held.kind === "text" && held.text).toContain(one.says);
    }
    harness.expect(client.workspace.unsettled(drafted.map((one) => one.transaction))).toEqual([]);

    /**
     * 4. And the server can still hand back what this client was looking at,
     * which is the question the whole design exists to answer.
     */
    await client.take(entry);
    await client.rebuildable();

    pocket.verdict =
      `${ROUNDS} rounds, ${accepted.length} accepted, ` +
      `${drafted.length} drafts all readable, nothing missing`;
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="p-3 font-mono text-xs">
      <p><b>{pocket.who}</b> — round {pocket.rounds}</p>
      <p>{pocket.verdict}</p>
      <ul>
        {#each pocket.log as line}
          <li>{line}</li>
        {/each}
      </ul>
    </div>
  {/snippet}
</Sweater>

<script lang="ts" module>
  import {
    agree,
    announce,
    awaiting,
    browser,
    other,
    playing,
    step,
  } from "./harness/collaboration";
</script>

<Sweater
  name="two people typing into one file lose nothing between them"
  body={async (harness: any) => {
    /**
     * The claim collaboration has to make, put under load: everything either
     * person typed is in the file at the end.
     *
     * Each round both append a line only they write, so a lost edit is a
     * missing line rather than a subtle difference somebody has to squint at
     * -- and the CRDT is what has to make both survive, since neither client
     * ever sees the other's line before writing its own.
     *
     * The network is taken away from one of them as they work, because that
     * is when merging is actually hard: an edit made while detached arrives
     * after edits that were made later.
     */
    const pocket: Pocket = harness.set(new Pocket());
    pocket.who = browser();

    const ROUNDS = 12;
    const id = await agree("soak-pair", `pair-${Date.now()}`);
    const workspaceId = await agree(
      "soak-pair-workspace",
      await project("ada@example.com"),
    );

    const client = await Collaborator.opened(me(), workspaceId);
    harness.onAbort(() => client.dispose());

    /** Ada makes the file; Grace waits to be told which it is. */
    const key = step(id, "pair", "entry");
    let entry: string;
    if (playing("ada")) {
      const made = client.workspace.create("pair.py", "start\n");
      await made.settled;
      entry = made.entry;
      await announce(key, entry);
    } else {
      entry = await awaiting(key);
    }
    await until(
      "the file to arrive",
      async () => client.workspace.entries().has(entry),
      30_000,
    );

    await client.open(entry);
    await until("the room to carry the file", () =>
      client.text(entry).includes("start"),
    );

    const mine = playing("ada") ? "ada" : "grace";
    for (let round = 0; round < ROUNDS; round += 1) {
      /**
       * Appended to what THIS client currently sees, which is the honest
       * thing an editor does -- neither of them waits to be told what the
       * other just typed.
       */
      /**
       * Zero-padded so no marker is a prefix of another: counting
       * occurrences of "ada 1" would also count "ada 10".
       */
      client.type(
        entry,
        `${client.text(entry)}${mine}-${String(round).padStart(2, "0")}\n`,
      );

      /**
       * One of them loses the ROOM for a round, alternately -- and every so
       * often loses the SERVER instead, which is the harder half.
       *
       * Losing the room means this client's typing reaches nobody until it
       * comes back. Losing the server means it reaches the others perfectly
       * well, through the room, while the FILE moves on without it -- so when
       * it returns the host has to carry a change into a document that has
       * drifted underneath it. That is the path a stored version travels, and
       * the one that panicked.
       */
      const detaching = round % 4 === (playing("ada") ? 1 : 3);
      const unplugged = round % 6 === (playing("ada") ? 2 : 5);
      if (detaching) client.goOffline(entry);
      if (unplugged) client.reachable(false);

      await announce(step(id, "pair", `typed-${round}-${mine}`));
      await awaiting(step(id, "pair", `typed-${round}-${playing("ada") ? "grace" : "ada"}`));

      /**
       * The wire first, then the room. Coming back to a room asks the host
       * where the file now stands, so doing it while the server is still away
       * simply cannot work -- and would be the test failing to model a
       * sequence a person could never be in.
       */
      if (unplugged) {
        client.reachable(true);
        client.workspace.nudge();
      }
      if (detaching) await client.comeBack(entry);

      /** Ada stores on even rounds, Grace on odd ones. */
      if (playing("ada") === (round % 2 === 0) && !unplugged) {
        await until("the room to speak", () => client.speaks(entry), 30_000);
        try {
          const stored = await client.store(entry);
          if (stored.held) pocket.note = `round ${round} kept: ${stored.why}`;
        } catch {
          /** The wire went while this was in flight. Queued, and sent later. */
          pocket.note = `round ${round} store is waiting`;
        }
      }
      pocket.note = `round ${round} done`;
    }

    /** Everybody back, and everything shared. */
    await announce(step(id, "pair", "typed-everything"));
    await awaiting(step(id, "pair", "typed-everything"));

    const wanted: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1)
      wanted.push(
        `ada-${String(round).padStart(2, "0")}`,
        `grace-${String(round).padStart(2, "0")}`,
      );

    await until(
      "every line either of them typed to be in this document",
      () => wanted.every((line) => client.text(entry).includes(line)),
      60_000,
      () =>
        `missing ${wanted.filter((line) => !client.text(entry).includes(line)).join(", ")}`,
    );

    /** And once it is stored, the FILE says all of it too. */
    await until("the room to speak", () => client.speaks(entry), 30_000);
    const stored = await client.store(entry);
    if (stored.held) throw new Error(`would not store: ${stored.why}`);
    await announce(step(id, "pair", `stored-${mine}`));
    await awaiting(step(id, "pair", `stored-${playing("ada") ? "grace" : "ada"}`));

    await until(
      "the file to hold every line",
      async () => {
        const held = await client.reads(entry);
        return wanted.every((line) => held.includes(line));
      },
      60_000,
    );

    /** Each line exactly once: merging twice is as bad as losing one. */
    const held = await client.reads(entry);
    for (const line of wanted)
      harness.expect(held.split(line).length - 1).toBe(1);

    pocket.text = held.split("\n").slice(0, 6).join("\n");
    pocket.verdict = `${wanted.length} lines, all present, none doubled`;
    await client.take(entry);
    await client.rebuildable();
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="p-3 font-mono text-xs">
      <p><b>{pocket.who}</b> — {pocket.note}</p>
      <p>{pocket.verdict}</p>
      <pre>{pocket.text}</pre>
    </div>
  {/snippet}
</Sweater>
