<script lang="ts" module>
  /**
   * How many times this page has run the suite, and how many bodies it has
   * run -- both at MODULE scope, which is the whole point.
   *
   * The counter these replace lived in the instance script, so it could not
   * see the thing most worth ruling out: the harness reloads the page by
   * itself (`Sweater.svelte`, `tryReload`) when it thinks a test changed, and
   * a reload re-runs every scenario against rooms that already hold the first
   * run's text. `loads` survives a reload; a body counter in a component
   * cannot.
   */
  const LOADS = "collab:loads";

  const counted = () => {
    try {
      const now = Number(sessionStorage.getItem(LOADS) ?? "0") + 1;
      sessionStorage.setItem(LOADS, String(now));
      return now;
    } catch {
      return 0;
    }
  };

  const loads = counted();
  let bodies = 0;

  /** Stamped into every failure message, because it is never in the assertion. */
  export const provenance = () => `loads=${loads} bodies=${bodies}`;
</script>

<script lang="ts">
  /**
   * Two browsers, one workspace, one room each time.
   *
   * The same file runs in Chromium and in Firefox at once and each plays a
   * different part -- Ada types, Grace watches, or the other way about. They
   * agree on things at `/rendezvous` and nowhere else, because every other
   * channel between them is the thing under test.
   *
   * HOW THIS FAILS. The two browsers execute these in the same order, so
   * scenario N here pairs with scenario N there. A test that dies in one
   * browser leaves its partner waiting on a barrier nobody will reach, which
   * shows up as a timeout in the OTHER browser one test later. Read the first
   * failure, not the loudest.
   */
  import { Sweater } from "sweater-vest-suede";

  import {
    agree,
    announce,
    awaiting,
    browser,
    me,
    other,
    playing,
    step,
    Collaborator,
  } from "./harness/collaboration";

  class Pocket {
    who = $state("");
    note = $state("");
    text = $state("");
  }

  /** One workspace for the whole run, agreed once by whoever asks first. */
  let shared: Promise<string> | undefined;
  const workspace = () =>
    (shared ??= (async () => {
      const answer = await fetch("/projects", {
        method: "POST",
        headers: { "X-User-Email": "ada@example.com" },
      });
      const mine = ((await answer.json()) as { id: string }).id;
      return agree("workspace", mine);
    })());

  /**
   * Wait for something, and say what was there instead when it never came.
   *
   * `seen` is the whole point of the third argument. A bare "waited 30000ms
   * for the stream to carry the store" says only that a condition stayed
   * false, which is the one thing already known -- and the difference between
   * "the token never moved" and "it moved somewhere else" is the difference
   * between a lost event and a mismatched id. Cheap to pass, and it is the
   * only evidence that survives a browser nobody is watching.
   */
  const until = async (
    what: string,
    holds: () => boolean,
    within = 30_000,
    seen?: () => string,
  ) => {
    const deadline = Date.now() + within;
    while (!holds()) {
      if (Date.now() > deadline) {
        const had = seen ? ` -- saw ${seen()}` : "";
        throw new Error(`waited ${within}ms for ${what}${had}`);
      }
      await new Promise((carry) => setTimeout(carry, 100));
    }
  };

  /**
   * The same wait, for something only the server can answer.
   *
   * Separate from `until` rather than folded into it: one polls state this
   * client already holds, the other asks somebody. Conflating them hides a
   * round trip inside what looks like a local check.
   */
  const untilAsked = async (
    what: string,
    ask: () => Promise<string>,
    holds: (said: string) => boolean,
    within = 30_000,
  ): Promise<string> => {
    const deadline = Date.now() + within;
    for (;;) {
      const said = await ask();
      if (holds(said)) return said;
      if (Date.now() > deadline)
        throw new Error(
          `waited ${within}ms for ${what} -- saw ${JSON.stringify(said)}`,
        );
      await new Promise((carry) => setTimeout(carry, 200));
    }
  };

  /** A collaborator wired to the shared workspace, torn down with the test. */
  const joined = async (harness: any) => {
    const id = await workspace();
    const client = await Collaborator.opened(me(), id);
    harness.onAbort(() => client.dispose());
    await until(
      "the workspace to settle",
      () => client.workspace.index().paths().length >= 0,
    );
    return client;
  };

  /**
   * Ada makes the file and says which it is; Grace waits to be told, then
   * waits again for her own stream to carry it. Both halves matter -- knowing
   * the id is not the same as the workspace having the entry.
   */
  const sharedFile = async (
    client: Collaborator,
    scenario: string,
    content = "",
  ) => {
    const id = await workspace();
    const key = step(id, scenario, "entry");
    const path = `${scenario}.py`;

    if (playing("ada")) {
      const { entry, settled } = client.workspace.create(path, content);
      await settled;
      await announce(key, entry);
    }
    const entry = await awaiting(key);
    await until(`${path} to arrive`, () =>
      client.workspace.entries().has(entry),
    );
    return entry;
  };
</script>

<Sweater config category="Collaboration" orientation="vertical" mode="serial" />

<Sweater
  name="converges when both type into one open file"
  body={async (harness) => {
    bodies += 1;
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "converge", "start\n");
    const id = await workspace();

    await client.open(entry);
    await until("the room to carry the file", () =>
      client.text(entry).includes("start"),
    );

    /**
     * Each writes their own line, at their own end. Concurrent inserts at one
     * point converge too, but which order they land in is the CRDT's business
     * and not something a test should be asserting about.
     */
    const mine = playing("ada") ? "ada was here\n" : "grace was here\n";
    const before = client.text(entry);
    client.type(entry, before + mine);
    const afterType = client.text(entry);
    await announce(step(id, "converge", `typed-${me()}`));
    await awaiting(step(id, "converge", `typed-${other()}`));

    await until(
      "both lines to arrive",
      () =>
        client.text(entry).includes("ada was here") &&
        client.text(entry).includes("grace was here"),
    );
    pocket.text = client.text(entry);

    /** And exactly once each -- the failure this whole design guards against. */
    const count = (needle: string) => pocket.text.split(needle).length - 1;
    if (count("ada was here") !== 1 || count("grace was here") !== 1)
      throw new Error(
        `[${browser()} ${me()} ${provenance()}] before=${JSON.stringify(before)} ` +
          `afterType=${JSON.stringify(afterType)} final=${JSON.stringify(pocket.text)}`,
      );
    harness.expect(count("ada was here")).toBe(1);

    /**
     * And the other half of every scenario: can this client still be handed
     * what it was looking at? A file that ends up right is not the whole of
     * it -- a snapshot naming work that never left this machine is one
     * nothing else can resolve.
     */
    await client.take(entry);
    await client.rebuildable();
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b></p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="shows a late joiner what was typed before they opened it"
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "latejoin", "");
    const id = await workspace();

    if (playing("ada")) {
      await client.open(entry);
      client.type(entry, "written before grace ever looked\n");
      const stored = await client.store(entry);
      if (stored.held)
        throw new Error(`the room would not store: ${stored.why}`);
      harness.expect(stored.rejected).toBe(false);
      await announce(step(id, "latejoin", "stored"));
      pocket.note = "typed and stored";
    } else {
      await awaiting(step(id, "latejoin", "stored"));
      await client.open(entry);
      await until("the text to arrive", () =>
        client.text(entry).includes("written before grace"),
      );
      pocket.note = "saw it on opening";
    }
    pocket.text = client.text(entry);
    const said = pocket.text.split("written before grace").length - 1;
    if (said !== 1)
      throw new Error(
        `said ${said} times -- [${browser()} ${me()}] ` +
          `base=${client.base(entry)} token=${client.token(entry)} ` +
          `text=${JSON.stringify(pocket.text)}`,
      );

    /**
     * And the other half of every scenario: can this client still be handed
     * what it was looking at? A file that ends up right is not the whole of
     * it -- a snapshot naming work that never left this machine is one
     * nothing else can resolve.
     */
    await client.take(entry);
    await client.rebuildable();
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="notices when somebody writes around the room"
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "around", "one\n");
    const id = await workspace();

    if (playing("ada")) {
      /** Ada has it open, as a room. This is the client that must notice. */
      await client.open(entry);
      await until("the room to carry the file", () =>
        client.text(entry).includes("one"),
      );
      await announce(step(id, "around", "open"));

      await awaiting(step(id, "around", "written"));
      await until("the outside write to reach the room", () =>
        client.text(entry).includes("written by a script"),
      );
      /**
       * Stamped by the server, which is what says the room was brought up to
       * date by the one writer allowed to do it rather than by this client
       * reading the file and typing the difference in.
       */
      await until(
        "the room to be stamped with the version it was carried to",
        () => client.base(entry) === client.token(entry),
        30_000,
        () => `base=${client.base(entry)} token=${client.token(entry)}`,
      );
      pocket.note = "carried in by the server";
    } else {
      /** Grace does NOT open it -- she writes the way a script would. */
      await awaiting(step(id, "around", "open"));
      await client.workspace.write("around.py", "one\nwritten by a script\n")
        .settled;
      await announce(step(id, "around", "written"));
      pocket.note = "wrote around the room";
    }
    pocket.text = client.text(entry);

    /**
     * And the other half of every scenario: can this client still be handed
     * what it was looking at? A file that ends up right is not the whole of
     * it -- a snapshot naming work that never left this machine is one
     * nothing else can resolve.
     */
    await client.take(entry);
    await client.rebuildable();
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="does not call it a conflict when both store from the same room"
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "bothstore", "shared\n");
    const id = await workspace();

    await client.open(entry);
    await until("the room to carry the file", () =>
      client.text(entry).includes("shared"),
    );
    await announce(step(id, "bothstore", `ready-${me()}`));
    await awaiting(step(id, "bothstore", `ready-${other()}`));

    /**
     * Both store at once, presenting the same token. One has to lose the
     * compare-and-swap -- and losing it must NOT look like a conflict, because
     * the two are already converged: the text that landed is the text both of
     * them are holding.
     */
    const stored = await client.store(entry);
    harness.expect(stored.held).toBe(false);
    pocket.note = stored.held
      ? stored.why
      : stored.rejected
        ? "lost the swap"
        : "landed";

    await until(
      "the two to agree on the file",
      () => client.base(entry) === client.token(entry),
      15_000,
    ).catch(() => undefined);

    /** Converged, and each of them said it once. */
    harness.expect(client.text(entry).split("shared").length - 1).toBe(1);

    /**
     * And the other half of every scenario: can this client still be handed
     * what it was looking at? A file that ends up right is not the whole of
     * it -- a snapshot naming work that never left this machine is one
     * nothing else can resolve.
     */
    await client.take(entry);
    await client.rebuildable();
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
  {/snippet}
</Sweater>

<Sweater
  name="merges an unnoticed lapse without doubling what was typed during it"
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "lapse", "base\n");
    const id = await workspace();

    await client.open(entry);
    await until("the room to carry the file", () =>
      client.text(entry).includes("base"),
    );
    await announce(step(id, "lapse", `open-${me()}`));
    await awaiting(step(id, "lapse", `open-${other()}`));

    if (playing("ada")) {
      /**
       * The network goes and Ada does not notice, which is the whole point:
       * the document is hers, so it goes on taking what she types, and every
       * one of those edits arrives at once when a provider is attached again.
       */
      client.goOffline(entry);
      client.type(entry, client.text(entry) + "ada kept typing\n");
      await announce(step(id, "lapse", "gone"));
      await awaiting(step(id, "lapse", "carried on"));
      await client.comeBack(entry);
      pocket.note = "lapsed, typed, came back";
    } else {
      await awaiting(step(id, "lapse", "gone"));
      client.type(entry, client.text(entry) + "grace carried on\n");
      await announce(step(id, "lapse", "carried on"));
      pocket.note = "carried on while ada was away";
    }

    await until(
      "both lines to arrive",
      () =>
        client.text(entry).includes("ada kept typing") &&
        client.text(entry).includes("grace carried on"),
    );
    pocket.text = client.text(entry);

    const count = (needle: string) => pocket.text.split(needle).length - 1;
    harness.expect(count("ada kept typing")).toBe(1);
    harness.expect(count("grace carried on")).toBe(1);
    harness.expect(count("base")).toBe(1);

    /**
     * And the other half of every scenario: can this client still be handed
     * what it was looking at? A file that ends up right is not the whole of
     * it -- a snapshot naming work that never left this machine is one
     * nothing else can resolve.
     */
    await client.take(entry);
    await client.rebuildable();
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="holds a store while the room is not reaching anybody"
  body={async (harness) => {
    /**
     * The finding this scenario exists for.
     *
     * A detached member is still perfectly able to reach the SERVER, and
     * storing from there looks harmless -- the write lands, the others hear
     * about it, and they repair towards it. But the text they repair towards
     * is text this member is about to hand them again through the document,
     * and a CRDT merges two inserts rather than noticing they say the same
     * thing. The file then says everything twice, and nobody involved did
     * anything wrong.
     *
     * So the rule is the one in `rooms.speaking`: the two channels are used
     * together or not at all. Lose the room and you have also lost the right
     * to write around it.
     */
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "held", "kept\n");
    const id = await workspace();

    await client.open(entry);
    await until("the room to carry the file", () =>
      client.text(entry).includes("kept"),
    );
    await announce(step(id, "held", `open-${me()}`));
    await awaiting(step(id, "held", `open-${other()}`));

    if (playing("ada")) {
      client.goOffline(entry);
      client.type(entry, client.text(entry) + "ada while away\n");
      /** Taken while nobody else could possibly have this text. */
      await client.take(entry);

      /**
       * And the person is told. Typing into a document that is reaching
       * nobody is safe -- it is kept, and it goes when the room comes back --
       * but somebody who is not told assumes their work is where everybody
       * else's is.
       */
      await until(
        "the room to say it is out of touch",
        () => client.trouble(entry) !== undefined,
        5_000,
      );
      harness.expect(client.trouble(entry)?.passing).toBe(true);
      harness.expect(client.trouble(entry)?.says).toBe("not reaching anybody");

      const held = await client.store(entry);
      if (!held.held)
        throw new Error(
          `stored anyway -- speaks=${client.speaks(entry)} attached=${client.attached(entry)}`,
        );
      if (client.speaks(entry))
        throw new Error(
          `still speaking while away -- attached=${client.attached(entry)} why=${held.why}`,
        );
      pocket.note = held.why;

      /**
       * Held from the FILE, not from the server. The work is durable the
       * moment it is typed, so there is nothing waiting to be retried -- and
       * it can be read back at the transaction it was kept under.
       */
      if (!held.held || held.draft === null)
        throw new Error("nothing was kept");
      harness
        .expect(await client.reads(entry, held.draft))
        .toBe(client.text(entry));
      harness.expect(await client.reads(entry)).not.toContain("ada while away");

      await client.comeBack(entry);
      await until("the room to speak again", () => client.speaks(entry));

      /**
       * And the draft is cleared once the work has gone out: the same
       * predicate that made it, flipped. Uncleared and old is the one thing
       * worth reporting, so it must not stay set once the work is shared.
       */
      await untilAsked(
        "the drafts to be cleared once the work got out",
        async () => JSON.stringify(await client.stranded()),
        (waiting) => waiting === "[]",
      );

      /** And now it may -- the others are holding the same text by then. */
      const stored = await client.store(entry);
      if (stored.held) throw new Error(`still held: ${stored.why}`);
      harness.expect(stored.rejected).toBe(false);
      await announce(step(id, "held", "stored"));
    } else {
      await awaiting(step(id, "held", "stored"));
      await until("ada's line to arrive", () =>
        client.text(entry).includes("ada while away"),
      );
      pocket.note = "saw it once ada was back";
    }

    await until("the two to agree", () =>
      client.text(entry).includes("ada while away"),
    );
    pocket.text = client.text(entry);

    /**
     * Thrown rather than asserted, so the failure carries the two things that
     * carry the text at the moment it fails. `expected 2 to be 1` on its own
     * does not say what the file ended up saying, or which member said it.
     */
    const said = pocket.text.split("ada while away").length - 1;
    const detail =
      `[${browser()} ${me()}] said=${said} ` +
      `base=${client.base(entry)} token=${client.token(entry)} ` +
      `text=${JSON.stringify(pocket.text)}`;
    if (said !== 1)
      throw new Error(`the line is not there exactly once -- ${detail}`);

    /**
     * And the other half of every scenario: can this client still be handed
     * what it was looking at? A file that ends up right is not the whole of
     * it -- a snapshot naming work that never left this machine is one
     * nothing else can resolve.
     */
    await client.take(entry);
    await client.rebuildable();
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="both lapse at once, both type, and both come back"
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "bothlapse", "shared start\n");
    const id = await workspace();

    await client.open(entry);
    await until("the room to carry the file", () =>
      client.text(entry).includes("shared start"),
    );
    await announce(step(id, "bothlapse", `open-${me()}`));
    await awaiting(step(id, "bothlapse", `open-${other()}`));

    /**
     * Both go, so neither is anybody's witness. Nothing either of them writes
     * during this reaches the other by any route -- which is what makes the
     * come-back the only place the two documents can be reconciled.
     */
    client.goOffline(entry);
    client.type(entry, client.text(entry) + `${me()} was alone\n`);
    /** Both of them holding text the other cannot have. */
    await client.take(entry);
    await announce(step(id, "bothlapse", `alone-${me()}`));
    await awaiting(step(id, "bothlapse", `alone-${other()}`));

    await client.comeBack(entry);
    await until(
      "both lines to arrive",
      () =>
        client.text(entry).includes("ada was alone") &&
        client.text(entry).includes("grace was alone"),
    );
    pocket.text = client.text(entry);
    pocket.note = "came back";

    const count = (needle: string) => pocket.text.split(needle).length - 1;
    harness.expect(count("ada was alone")).toBe(1);
    harness.expect(count("grace was alone")).toBe(1);
    harness.expect(count("shared start")).toBe(1);

    /** And one of them storing afterwards is not a conflict for the other. */
    await until("the room to speak again", () => client.speaks(entry));
    if (playing("ada")) {
      const stored = await client.store(entry);
      if (stored.held)
        throw new Error(`the room would not store: ${stored.why}`);
      await announce(step(id, "bothlapse", "stored"));
    } else {
      await awaiting(step(id, "bothlapse", "stored"));
      await until(
        "the stream to carry it",
        () => client.base(entry) === client.token(entry),
        15_000,
      ).catch(() => undefined);
    }
    const still = (needle: string) =>
      client.text(entry).split(needle).length - 1;
    const detail =
      `[${browser()} ${me()}] ada=${still("ada was alone")} ` +
      `grace=${still("grace was alone")} ` +
      `base=${client.base(entry)} token=${client.token(entry)} ` +
      `text=${JSON.stringify(client.text(entry))}`;
    if (still("ada was alone") !== 1 || still("grace was alone") !== 1)
      throw new Error(`somebody was said twice -- ${detail}`);

    /**
     * And the other half of every scenario: can this client still be handed
     * what it was looking at? A file that ends up right is not the whole of
     * it -- a snapshot naming work that never left this machine is one
     * nothing else can resolve.
     */
    await client.take(entry);
    await client.rebuildable();
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="a write that is not text takes the file away from the room"
  body={async (harness) => {
    /**
     * The design decision this checks, taken before it was written: the write
     * LANDS. A room showing text has nothing to merge bytes into, so refusing
     * would be a door that loses data, and merging is not on the table. What
     * is left is telling the room its file stopped being what it is showing,
     * and that is what `replacement` records.
     */
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "binary", "readable\n");
    const id = await workspace();

    if (playing("ada")) {
      await client.open(entry);
      await until("the room to carry the file", () =>
        client.text(entry).includes("readable"),
      );
      await announce(step(id, "binary", "open"));

      await awaiting(step(id, "binary", "replaced"));
      await until(
        "the room to be told the file is not its text any more",
        () => client.replacement(entry) !== undefined,
        30_000,
        () =>
          `token=${client.token(entry)} speaks=${client.speaks(entry)} ` +
          `base=${client.base(entry)}`,
      );
      pocket.note = `stood down: ${client.replacement(entry)?.mime}`;

      /**
       * And the work it was showing went somewhere before it stood down.
       * A kernel's output must not quietly take text its author never
       * stored -- nobody chose that, it just happened to them.
       */
      const ended = client.replacement(entry);
      if (ended?.kept == null)
        throw new Error("stood down without keeping the text");
      harness.expect(await client.reads(entry, ended.kept)).toBe("readable\n");

      /** Not corrupted, and not repaired: the document is left as it was. */
      harness.expect(client.text(entry)).toBe("readable\n");
      harness.expect(client.speaks(entry)).toBe(false);
      harness.expect(client.replacement(entry)?.mime).toBe("image/png");

      /** And it may not write its stale text back over the bytes. */
      const held = await client.store(entry);
      harness.expect(held.held).toBe(true);
    } else {
      /** Grace never opens it. She writes bytes the way a kernel would. */
      await awaiting(step(id, "binary", "open"));
      const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
      const answer = await client.replace(entry, png, "image/png");
      harness.expect(answer.rejected).toBe(false);
      await announce(step(id, "binary", "replaced"));
      pocket.note = "wrote bytes over it";
    }
    pocket.text = client.text(entry);

    /**
     * And the other half of every scenario: can this client still be handed
     * what it was looking at? A file that ends up right is not the whole of
     * it -- a snapshot naming work that never left this machine is one
     * nothing else can resolve.
     */
    await client.take(entry);
    await client.rebuildable();
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="rebuilds what a client was looking at after the file has moved on"
  body={async (harness) => {
    /**
     * The loop this closes. A client writes down four tokens per entry; the
     * file then moves on; and the server hands back what those transactions
     * SAID rather than what the file holds now. That is the difference
     * between an assistant reading the screen somebody asked about and one
     * reading the screen as it is by the time it answers.
     */
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "rebuild", "before\n");
    const id = await workspace();

    await client.open(entry);
    await until("the room to carry the file", () =>
      client.text(entry).includes("before"),
    );
    await announce(step(id, "rebuild", `open-${me()}`));
    await awaiting(step(id, "rebuild", `open-${other()}`));

    if (playing("ada")) {
      await until("the room to speak", () => client.speaks(entry));
      client.type(entry, client.text(entry) + "ada wrote this\n");
      const looking = client.text(entry);
      const stored = await client.store(entry);
      if (stored.held)
        throw new Error(`the room would not store: ${stored.why}`);
      harness.expect(stored.rejected).toBe(false);

      /** The snapshot has to name the version, so wait for it to be one. */
      await until(
        "the stream to carry the store",
        () => client.token(entry) === stored.transaction,
        30_000,
        () =>
          `token=${client.token(entry)} wanted=${stored.transaction} ` +
          /**
           * The one question that splits the two explanations. If the
           * transaction is still unsettled, its confirming event never
           * evicted it from the outbox -- a delivery problem. If it has
           * settled and the token still has not moved, the event arrived and
           * the view did not follow it -- a different bug entirely.
           */
          `unsettled=${JSON.stringify(client.workspace.unsettled([stored.transaction]))} ` +
          /**
           * `unsettled` reads the CONFIRMED map; `token` reads the EFFECTIVE
           * view. When the first says the transaction landed and the second
           * does not show it, the two disagree -- and the only way to tell
           * "it landed on another entry" from "this entry's view is stale" is
           * to look at every entry at once.
           */
          `entries=${JSON.stringify(
            [...client.workspace.entries().entries()].map(([id, held]) => ({
              id: id.slice(0, 8),
              content: held.content_version?.slice(0, 8) ?? null,
              name: held.name,
            })),
          )}`,
      );
      const taken = [client.snapshot(entry)];

      /** Empty is what makes it portable -- see `Workspace.unsettled`. */
      harness.expect(client.unsettled(taken)).toEqual([]);
      await announce(step(id, "rebuild", "snapped"));

      /** Now let the file move on underneath the snapshot. */
      await awaiting(step(id, "rebuild", "moved"));
      await until(
        "the file to have moved past it",
        () => client.token(entry) !== stored.transaction,
      );

      const [rebuilt] = await client.rebuild(taken);
      pocket.note = "rebuilt";
      harness.expect(rebuilt.unresolved).toEqual([]);
      harness.expect(rebuilt.content?.type).toBe("text");
      const said =
        rebuilt.content?.type === "text" ? rebuilt.content.content : "";
      pocket.text = said;

      /** What she was looking at, NOT what the file says now. */
      harness.expect(said).toBe(looking);
      harness.expect(said.includes("grace moved it on")).toBe(false);
    } else {
      await awaiting(step(id, "rebuild", "snapped"));
      await until("the room to speak", () => client.speaks(entry));
      client.type(entry, client.text(entry) + "grace moved it on\n");
      const stored = await client.store(entry);
      if (stored.held)
        throw new Error(`the room would not store: ${stored.why}`);
      await announce(step(id, "rebuild", "moved"));
      pocket.note = "moved the file on";
      pocket.text = client.text(entry);
    }

    /**
     * And the other half of every scenario: can this client still be handed
     * what it was looking at? A file that ends up right is not the whole of
     * it -- a snapshot naming work that never left this machine is one
     * nothing else can resolve.
     */
    await client.take(entry);
    await client.rebuildable();
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="keeps what was typed when the tab holding it goes away"
  body={async (harness) => {
    /**
     * The rung below the room. Ada types while she can reach nobody, and then
     * her tab is gone -- no store landed, no update reached anybody. The only
     * copy is on her machine, and it has to still be there.
     *
     * `SCENARIOS.md` E2 and E3: without this the work is simply lost, and it
     * is the one exposure no server design can close.
     */
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "keeps", "start\n");
    const id = await workspace();

    if (playing("ada")) {
      await client.open(entry);
      await until("the room to carry the file", () =>
        client.text(entry).includes("start"),
      );

      client.goOffline(entry);
      client.type(entry, client.text(entry) + "typed then closed\n");
      const wanted = client.text(entry);

      /** The tab goes. Nothing was stored and nothing was shared. */
      await client.dispose();

      const reopened = await joined(harness);
      await reopened.open(entry);
      await until("the machine to hand back what it was holding", () =>
        reopened.text(entry).includes("typed then closed"),
      );
      harness.expect(reopened.text(entry)).toBe(wanted);
      pocket.text = reopened.text(entry);
      pocket.note = "still here after the tab went";

      /** And once it is back, it reaches everybody the ordinary way. */
      await until("the room to speak again", () => reopened.speaks(entry));
      const stored = await reopened.store(entry);
      if (stored.held) throw new Error(`would not store: ${stored.why}`);
      await announce(step(id, "keeps", "stored"));
      await reopened.take(entry);
      await reopened.rebuildable();
    } else {
      await client.open(entry);
      await awaiting(step(id, "keeps", "stored"));
      await until("ada's typing to arrive", () =>
        client.text(entry).includes("typed then closed"),
      );
      pocket.text = client.text(entry);
      pocket.note = "saw it once her tab came back";
      harness.expect(pocket.text.split("typed then closed").length - 1).toBe(1);
      await client.take(entry);
      await client.rebuildable();
    }
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="treats two tabs of one browser as two clients"
  body={async (harness) => {
    /**
     * Two tabs is not an exotic case -- people open them constantly -- and
     * "it happens to work" is not a claim worth making without a test.
     *
     * They are the same user on the same machine, so they share what a
     * machine shares: local storage, keyed by entry. Nothing may assume it is
     * the only client here.
     */
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "twotabs", "one file\n");
    const id = await workspace();

    if (playing("ada")) {
      const second = await joined(harness);
      await client.open(entry);
      await second.open(entry);
      await until(
        "both tabs to carry the file",
        () =>
          client.text(entry).includes("one file") &&
          second.text(entry).includes("one file"),
      );

      client.type(entry, client.text(entry) + "from the first tab\n");
      await until("the second tab to see the first", () =>
        second.text(entry).includes("from the first tab"),
      );
      second.type(entry, second.text(entry) + "from the second tab\n");
      await until("the first tab to see the second", () =>
        client.text(entry).includes("from the second tab"),
      );

      const said = (who: Collaborator, needle: string) =>
        who.text(entry).split(needle).length - 1;
      harness.expect(said(client, "from the first tab")).toBe(1);
      harness.expect(said(second, "from the second tab")).toBe(1);

      await until("the room to speak", () => second.speaks(entry));
      const stored = await second.store(entry);
      if (stored.held)
        throw new Error(`the second tab would not store: ${stored.why}`);
      await announce(step(id, "twotabs", "stored"));

      pocket.text = client.text(entry);
      pocket.note = "two tabs, one file";
      await second.take(entry);
      await second.rebuildable();
    } else {
      await client.open(entry);
      await awaiting(step(id, "twotabs", "stored"));
      await until(
        "both tabs' work to arrive",
        () =>
          client.text(entry).includes("from the first tab") &&
          client.text(entry).includes("from the second tab"),
      );
      pocket.text = client.text(entry);
      pocket.note = "saw both tabs";
      const count = (needle: string) => pocket.text.split(needle).length - 1;
      harness.expect(count("from the first tab")).toBe(1);
      harness.expect(count("from the second tab")).toBe(1);
    }
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="keeps what was on screen when the file is deleted underneath it"
  body={async (harness) => {
    /**
     * The deletion case, which had no coverage at all. A file going away is
     * somebody else's decision, and it must not take unstored work with it --
     * the room stands down, and what it was showing is recoverable.
     */
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "deleted", "still here\n");
    const id = await workspace();

    if (playing("ada")) {
      await client.open(entry);
      await until("the room to carry the file", () =>
        client.text(entry).includes("still here"),
      );
      client.type(entry, client.text(entry) + "typed but never stored\n");
      const showing = client.text(entry);
      await announce(step(id, "deleted", "open"));

      await awaiting(step(id, "deleted", "gone"));
      await until(
        "the room to be told the file is gone",
        () => client.replacement(entry) !== undefined,
      );

      const ended = client.replacement(entry);
      harness.expect(ended?.mime).toBe(null);
      if (ended?.kept == null)
        throw new Error("the file went and took the work with it");
      harness.expect(await client.reads(entry, ended.kept)).toBe(showing);
      harness.expect(client.speaks(entry)).toBe(false);
      pocket.note = "stood down, work kept";
      pocket.text = showing;
    } else {
      await awaiting(step(id, "deleted", "open"));
      await client.workspace.remove("deleted.py").settled;
      await announce(step(id, "deleted", "gone"));
      pocket.note = "deleted it";
    }
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="stores work that reached the room and never reached the file"
  body={async (harness) => {
    /**
     * `SCENARIOS.md` D3. Typing that was SHARED but never stored sits at the
     * room's rung and no further -- safe while the room is alive, gone when
     * it is evicted. Whoever opens the file next is the one who can still see
     * it, so they are the one who stores it.
     */
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "nobody", "start\n");
    const id = await workspace();

    if (playing("ada")) {
      await client.open(entry);
      await until("the room to carry the file", () =>
        client.text(entry).includes("start"),
      );
      client.type(entry, client.text(entry) + "shared but never stored\n");
      /**
       * Announced only once the room actually has it. Announcing on the
       * keystroke would let the other tab open before the update landed, and
       * then which rung the work had reached would depend on the network.
       */
      await client.handedOver(entry);
      await announce(step(id, "nobody", "typed"));

      /** Nobody stores it. Ada's tab simply goes. */
      await awaiting(step(id, "nobody", "seen"));
      await client.dispose();
      await announce(step(id, "nobody", "gone"));
      pocket.note = "typed it and left";
    } else {
      await awaiting(step(id, "nobody", "typed"));

      /** Sharing writes nothing, so the file still says what it always said. */
      harness.expect(await client.reads(entry)).toBe("start\n");

      /**
       * Opening is the rescue. Whoever opens the file next is the one who can
       * still see the work, so they are the one who stores it -- it happens
       * during the open, not at some later save.
       */
      await client.open(entry);
      harness.expect(client.text(entry)).toContain("shared but never stored");
      const said = await untilAsked(
        "the file to be told at last",
        () => client.reads(entry),
        (text) => text.includes("shared but never stored"),
      );
      pocket.text = said;
      pocket.note = "stored by whoever opened it next";
      await announce(step(id, "nobody", "seen"));
      await awaiting(step(id, "nobody", "gone"));
      await client.take(entry);
      await client.rebuildable();
    }
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="merges work from a session that ended before the file moved on"
  body={async (harness) => {
    /**
     * `SCENARIOS.md` D2, and the decision recorded against it: old local work
     * ALWAYS merges, with no threshold. The version before the merge is
     * stored, so the state it merged into is recoverable -- silent merging is
     * never destructive, only occasionally surprising, and the way back
     * exists.
     */
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "later", "shared\n");
    const id = await workspace();

    if (playing("ada")) {
      await client.open(entry);
      await until("the room to carry the file", () =>
        client.text(entry).includes("shared"),
      );

      /** Ada types where nobody can see her, and her session ends. */
      client.goOffline(entry);
      client.type(entry, client.text(entry) + "ada that morning\n");
      await client.dispose();
      await announce(step(id, "later", "gone"));

      /** Grace has the whole file to herself, and moves it on. */
      await awaiting(step(id, "later", "moved"));

      /** Ada comes back much later, onto a file that is not what she left. */
      const returning = await joined(harness);
      await returning.open(entry);
      await until(
        "both mornings to be in one file",
        () =>
          returning.text(entry).includes("ada that morning") &&
          returning.text(entry).includes("grace that afternoon"),
      );

      const said = (needle: string) =>
        returning.text(entry).split(needle).length - 1;
      harness.expect(said("ada that morning")).toBe(1);
      harness.expect(said("grace that afternoon")).toBe(1);
      pocket.text = returning.text(entry);
      pocket.note = "merged, each once";

      /** The state before her work returned is still there to go back to. */
      const before = returning.token(entry);
      if (before == null) throw new Error("nothing to go back to");
      harness
        .expect(await returning.reads(entry, before))
        .toContain("grace that afternoon");
      await returning.take(entry);
      await returning.rebuildable();
    } else {
      await awaiting(step(id, "later", "gone"));
      await client.open(entry);
      await until("the room to carry the file", () =>
        client.text(entry).includes("shared"),
      );
      await until("the room to speak", () => client.speaks(entry));
      client.type(entry, client.text(entry) + "grace that afternoon\n");
      const stored = await client.store(entry);
      if (stored.held) throw new Error(`would not store: ${stored.why}`);
      await announce(step(id, "later", "moved"));
      pocket.note = "had it to herself";
      await client.take(entry);
      await client.rebuildable();
    }
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="keeps the room when the file is renamed underneath it"
  body={async (harness) => {
    /**
     * `SCENARIOS.md` H1. Rooms are keyed by entry id, not by path, so a
     * rename is nothing to them -- which is worth a test precisely because it
     * is the kind of thing that quietly stops being true.
     */
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "renamed", "before the rename\n");
    const id = await workspace();

    await client.open(entry);
    await until("the room to carry the file", () =>
      client.text(entry).includes("before the rename"),
    );
    await announce(step(id, "renamed", `open-${me()}`));
    await awaiting(step(id, "renamed", `open-${other()}`));

    if (playing("grace")) {
      await client.workspace.move("renamed.py", "renamed-again.py").settled;
      await announce(step(id, "renamed", "moved"));
    } else {
      await awaiting(step(id, "renamed", "moved"));
      await until("the new name to arrive", () =>
        client.workspace.index().paths().includes("renamed-again.py"),
      );

      /** Still the same room, still able to write the file back. */
      await until("the room to speak", () => client.speaks(entry));
      client.type(entry, client.text(entry) + "typed after the rename\n");
      const stored = await client.store(entry);
      if (stored.held)
        throw new Error(`the rename took the room: ${stored.why}`);
      pocket.note = "same room, new name";
      pocket.text = client.text(entry);
      await announce(step(id, "renamed", "stored"));
    }

    if (playing("grace")) {
      await awaiting(step(id, "renamed", "stored"));
      await until("the typing to arrive", () =>
        client.text(entry).includes("typed after the rename"),
      );
      harness
        .expect(client.text(entry).split("typed after the rename").length - 1)
        .toBe(1);
      pocket.text = client.text(entry);
      pocket.note = "saw it under the new name";
    }
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="reaches the others through the host when the room cannot be reached"
  body={async (harness) => {
    /**
     * `SCENARIOS.md` B3, from the other side. Losing the collaboration server
     * should cost the direct route to everybody else, not everybody else.
     *
     * Ada can reach this host and not the room. Her work is kept as a draft
     * so it cannot be lost, AND handed to the host to put in the room, so
     * Grace sees it while Ada is still cut off. It goes as an update, not as
     * text, so when Ada's own connection returns and delivers it again it
     * merges rather than doubling.
     */
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "relay", "shared\n");
    const id = await workspace();

    await client.open(entry);
    await until("the room to carry the file", () =>
      client.text(entry).includes("shared"),
    );
    await announce(step(id, "relay", `open-${me()}`));
    await awaiting(step(id, "relay", `open-${other()}`));

    if (playing("ada")) {
      client.goOffline(entry);
      client.type(entry, client.text(entry) + "sent the long way round\n");

      /** Held from the file, kept as a draft, and handed to the host. */
      const held = await client.store(entry);
      harness.expect(held.held).toBe(true);
      await announce(step(id, "relay", "handed"));

      await awaiting(step(id, "relay", "seen"));
      await client.comeBack(entry);
      await until("her own connection to deliver it too", () =>
        client.speaks(entry),
      );

      /** Arrived twice, by two routes, and said once. */
      harness
        .expect(client.text(entry).split("sent the long way round").length - 1)
        .toBe(1);
      pocket.text = client.text(entry);
      pocket.note = "reached them without a room";
      await client.take(entry);
      await client.rebuildable();
    } else {
      await awaiting(step(id, "relay", "handed"));
      await until("ada's work to arrive without her", () =>
        client.text(entry).includes("sent the long way round"),
      );
      harness
        .expect(client.text(entry).split("sent the long way round").length - 1)
        .toBe(1);
      pocket.text = client.text(entry);
      pocket.note = "saw it while she was cut off";
      await announce(step(id, "relay", "seen"));
      await client.take(entry);
      await client.rebuildable();
    }
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="gives back what a closed file was holding when it is opened again"
  body={async (harness) => {
    /**
     * Invariant 7: detaching never discards. Closing a file is not a
     * decision about the work in it -- only deleting is -- so unstored
     * typing has to survive the room being put down and picked up.
     *
     * Closed while reaching nobody, so nobody else is holding it either and
     * the machine is genuinely the only copy.
     */
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "closed", "kept\n");
    const id = await workspace();

    if (playing("ada")) {
      await client.open(entry);
      await until("the room to carry the file", () =>
        client.text(entry).includes("kept"),
      );

      client.goOffline(entry);
      client.type(entry, client.text(entry) + "typed then closed\n");
      const showing = client.text(entry);
      await client.close(entry);

      await client.open(entry);
      await until("the file to be handed back", () =>
        client.text(entry).includes("typed then closed"),
      );
      harness.expect(client.text(entry)).toBe(showing);
      pocket.text = client.text(entry);
      pocket.note = "closed and reopened, nothing lost";

      await until("the room to speak", () => client.speaks(entry));
      const stored = await client.store(entry);
      if (stored.held) throw new Error(`would not store: ${stored.why}`);
      await announce(step(id, "closed", "stored"));
    } else {
      await client.open(entry);
      await until("the room to carry the file", () =>
        client.text(entry).includes("kept"),
      );
      await awaiting(step(id, "closed", "stored"));
      await until("ada's typing to arrive", () =>
        client.text(entry).includes("typed then closed"),
      );
      harness
        .expect(client.text(entry).split("typed then closed").length - 1)
        .toBe(1);
      pocket.text = client.text(entry);
      pocket.note = "saw it once";
    }
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="sends work queued before the tab went, once it is opened again"
  body={async (harness) => {
    /**
     * The outbox, across page loads, against a real IndexedDB.
     *
     * Everything else in this client exists so that work reaches the server,
     * and until now all of it lived in one closure that a reload emptied. A
     * design whose claim is "a user never loses work" cannot keep the only
     * copy of that work in memory.
     *
     * Solo on purpose: one machine losing the server and coming back is not a
     * question about two clients, and making it one would only add a barrier.
     */
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    if (!playing("ada")) {
      pocket.note = "not this one's scenario";
      return;
    }

    const id = await workspace();
    const client = await Collaborator.opened(me(), id);
    harness.onAbort(() => client.dispose());
    const { entry, settled } = client.workspace.create(
      "outlived.py",
      "start\n",
    );
    await settled;

    /**
     * The server goes. What is typed now is answered by nobody, so it stays in
     * the queue -- and the queue is the thing being tested, so nothing here
     * awaits an answer that is never coming.
     */
    client.reachable(false);
    const queued = client.workspace.write(
      "outlived.py",
      "start\nqueued while away\n",
    );
    void queued.settled.catch(() => undefined);
    await new Promise((carry) => setTimeout(carry, 500));

    /** And the tab goes. Nothing in memory survives this; the store does. */
    await client.dispose();

    const again = await Collaborator.opened(me(), id);
    harness.onAbort(() => again.dispose());
    await until("the new tab to have the file at all", () =>
      again.workspace.entries().has(entry),
    );
    const said = await untilAsked(
      "the queued write to reach the server",
      () => again.reads(entry),
      (text) => text.includes("queued while away"),
    );
    harness.expect(said).toContain("queued while away");

    /** And it is not merely on the server -- it is settled, so it is portable. */
    await until(
      "the answer to be written down too",
      () => again.workspace.unsettled([queued.transaction]).length === 0,
      15_000,
    );
    pocket.text = said;
    pocket.note = "queued in a tab that closed, sent by the next one";
    await again.rebuildable();
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="loses the server but keeps the room"
  body={async (harness) => {
    /**
     * `SCENARIOS.md` B3, from the side that had no switch until now.
     *
     * The two planes fail independently, and this is the asymmetry the draft
     * design rests on: losing the ROOM costs the right to write the file,
     * because what you hold is not shared. Losing the SERVER costs nothing of
     * the sort -- the work still reaches everybody through the room, and the
     * next person to store carries it. Nothing is kept as a draft, because
     * nothing is private.
     */
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "roomonly", "start\n");
    const id = await workspace();

    await client.open(entry);
    await until("the room to carry the file", () =>
      client.text(entry).includes("start"),
    );
    await announce(step(id, "roomonly", "open"));
    await awaiting(step(id, "roomonly", "open"));

    if (playing("ada")) {
      /** The server goes. The room does not. */
      client.reachable(false);
      client.type(entry, client.text(entry) + "typed with no server\n");
      await client.handedOver(entry);
      await announce(step(id, "roomonly", "typed"));

      await awaiting(step(id, "roomonly", "stored"));
      client.reachable(true);
      await untilAsked(
        "the file to come back holding it",
        () => client.reads(entry),
        (text) => text.includes("typed with no server"),
      );
      /** Once, not twice: it reached the file by exactly one route. */
      harness
        .expect(client.text(entry).split("typed with no server").length - 1)
        .toBe(1);
      pocket.note = "reached everybody without reaching the server";
    } else {
      await awaiting(step(id, "roomonly", "typed"));
      await until("the typing to arrive through the room", () =>
        client.text(entry).includes("typed with no server"),
      );
      /** And this client, which can reach the server, is the one that stores it. */
      await until("the room to speak", () => client.speaks(entry));
      const stored = await client.store(entry);
      if (stored.held) throw new Error(`would not store: ${stored.why}`);
      await announce(step(id, "roomonly", "stored"));
      pocket.note = "carried it to the file on her behalf";
    }
    pocket.text = client.text(entry);
    await client.take(entry);
    await client.rebuildable();
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="rolls a file back to an earlier version while somebody has it open"
  body={async (harness) => {
    /**
     * `SCENARIOS.md` F5 and H4. A restore is a server-origin write like any
     * other -- the same path a script's write takes -- and the reason it is
     * worth its own scenario is that its content is text the room has ALREADY
     * SEEN. A document that reasoned about what it recognised, rather than
     * about what the server stamped, would decide there was nothing to do and
     * quietly leave the file and the room disagreeing.
     */
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "rolledback", "first\n");
    const id = await workspace();

    if (playing("ada")) {
      /** Ada holds the room. She is the one who must be brought back. */
      await client.open(entry);
      await until("the room to carry the file", () =>
        client.text(entry).includes("first"),
      );
      const original = client.token(entry);
      await announce(step(id, "rolledback", "open"), original ?? "");

      await until("the second version to arrive", () =>
        client.text(entry).includes("second"),
      );
      await announce(step(id, "rolledback", "moved on"));

      await awaiting(step(id, "rolledback", "rolled back"));
      await until(
        "the room to be handed the older text again",
        () => !client.text(entry).includes("second"),
        30_000,
        () => JSON.stringify(client.text(entry)),
      );
      harness.expect(client.text(entry)).toBe("first\n");
      await until(
        "the room to be stamped with the version it was carried to",
        () => client.base(entry) === client.token(entry),
        30_000,
        () => `base=${client.base(entry)} token=${client.token(entry)}`,
      );
      pocket.note = "rolled back underneath an open document";
    } else {
      /** Grace has no document, so she writes the way a restore would. */
      const original = await awaiting(step(id, "rolledback", "open"));
      await client.workspace.write("rolledback.py", "first\nsecond\n").settled;
      await awaiting(step(id, "rolledback", "moved on"));

      const older = await client.reads(entry, original);
      harness.expect(older).toBe("first\n");
      await client.workspace.write("rolledback.py", older).settled;
      await announce(step(id, "rolledback", "rolled back"));
      pocket.note = "restored what it said before";
    }
    pocket.text = client.text(entry);
    await client.take(entry);
    await client.rebuildable();
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="two tabs on one workspace do not eat each other's queued work"
  body={async (harness) => {
    /**
     * Browser storage is shared per origin, so the outbox being durable makes
     * a sentence load-bearing that used to be free: NOTHING MAY ASSUME AN
     * ENTRY IN THE OUTBOX WAS WRITTEN BY THE TAB THAT FINDS IT.
     *
     * The sharp edge is the byte store. A queued write is a row of pointers,
     * and when one tab's write is answered it releases the payloads nothing
     * needs any more -- computed from ITS queue, which knows nothing of the
     * other tab's. Releasing against one tab's view would take bytes the other
     * tab's chained delta is the only remaining reader of. So releases are
     * checked against what is WRITTEN DOWN, and this is what says so.
     *
     * Solo: two tabs is one browser, and a second browser would only add a
     * barrier to wait on.
     */
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    if (!playing("ada")) {
      pocket.note = "not this one's scenario";
      return;
    }

    const id = await workspace();
    const one = await Collaborator.opened(me(), id);
    harness.onAbort(() => one.dispose());
    const mine = one.workspace.create("mine.py", "start\n");
    const theirs = one.workspace.create("theirs.py", "start\n");
    await Promise.all([mine.settled, theirs.settled]);

    /** The first tab loses the server and types a chain nobody has answered. */
    one.reachable(false);
    const queued = [
      one.workspace.write("mine.py", "start\none\n"),
      one.workspace.write("mine.py", "start\none\ntwo\n"),
      one.workspace.write("mine.py", "start\none\ntwo\nthree\n"),
    ];
    queued.forEach((sent) => void sent.settled.catch(() => undefined));
    await new Promise((carry) => setTimeout(carry, 500));

    /**
     * The second tab is fine, and busy. Every write it lands is answered and
     * evicted, and every eviction releases bytes -- against the same store the
     * first tab's chain is written down in.
     */
    const two = await Collaborator.opened(me(), id);
    harness.onAbort(() => two.dispose());
    for (const said of ["one", "two", "three", "four"])
      await two.workspace.write("theirs.py", `start\n${said}\n`).settled;

    /** And the first tab comes back. Its chain has to be intact. */
    one.reachable(true);
    const said = await untilAsked(
      "the first tab's queued chain to land",
      () => one.reads(mine.entry),
      (text) => text.includes("three"),
    );
    harness.expect(said).toBe("start\none\ntwo\nthree\n");

    /**
     * The last of the chain is the file's current version, so this tab can
     * see for itself that it landed. The two behind it were answered while
     * the OTHER tab was the one talking, and an answer is remembered by the
     * tab that received it -- so this one still calls them unsettled. That is
     * the conservative direction, and the honest test of whether the work is
     * really somewhere else is the rebuild below.
     */
    harness
      .expect(one.workspace.unsettled([queued[queued.length - 1]!.transaction]))
      .toEqual([]);

    pocket.text = said;
    pocket.note = "kept its chain while the other tab churned the store";
    await one.rebuildable();
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>
