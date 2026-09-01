<script lang="ts">
  /**
   * The tutor, end to end and on its own page.
   *
   * ITS OWN COMPONENT, and that is the point of it. This is the one test that
   * goes all the way -- shell to transport to host to a real model and back --
   * so it creates a workspace, opens a file, asks, and then puts a whole new
   * shell on the same workspace to prove the conversation survives a reload.
   *
   * It cannot live in `Sample.test.svelte`. That page runs twenty-one tests
   * against one global editor filesystem and one set of tracked clients, and
   * `opened()` puts every other client on the page down when it is called.
   * A test that holds a workspace open across several seconds of model
   * latency and then opens a SECOND shell on it is not a good neighbour
   * there, and the neighbours are not good ones back.
   *
   * Everything below the panel is covered against a scripted tutor -- in
   * `tests/tutor.py` over real HTTP, and in the Assistant suite for the panel
   * itself -- so what this adds is only that the pieces are joined.
   */
  import { Sweater } from "sweater-vest-suede";
  import { createClient } from "@liveblocks/client";
  import Shell from "../../../../release/frontend/svelte/Workspace.svelte";
  import { Conversation } from "../../../../release/frontend/svelte/assistant/conversation.svelte";
  import FileTree, {
    Model as FileTreeModel,
  } from "../../../../release/frontend/svelte/FileTree.svelte";
  import { drivable } from "./harness/liveblocks";
  import {
    alongside,
    clickRow,
    drawn,
    opened,
    rowFor,
    until,
    type Client,
  } from "./harness/testing.svelte";

  /** A real room, because the shell will not show an editor without one. */
  const live = createClient({
    authEndpoint: async (asked?: string) => {
      const answer = await fetch(
        `/liveblocks/token?rooms=${encodeURIComponent(asked ?? "")}`,
        { headers: { "X-User-Email": "ada@example.com" } },
      );
      if (!answer.ok) throw new Error(`token: ${answer.status}`);
      return (await answer.json()) as { token: string };
    },
  });
  const liveRoom = drivable(live);

  const tall = { height: 900 };

  class Pocket {
    root = $state<HTMLElement>();
    workspace = $state<Client>();
    tree = $state<FileTreeModel>();
    editor = $state<any>();
  }

  const showing = (pocket: Pocket, workspace: Client) => {
    pocket.tree = new FileTreeModel(workspace.workspace);
    pocket.workspace = workspace;
  };
</script>

<Sweater config category="Tutor" orientation="vertical" mode="serial" />

<Sweater
  name="the tutor answers a question about the file that is open"
  lazy
  body={async (harness) => {
    /**
     * THE WHOLE WIRE, and the only test that is: shell to transport to host to
     * model and back again as it is written. Everything below the panel is
     * covered against a scripted tutor -- in `tests/tutor.py` over real HTTP,
     * and in the Assistant suite for the panel itself -- so what this adds is
     * that the pieces are joined, which nothing else can say.
     *
     * Deliberately incurious about the ANSWER. A model is not a fixture and
     * asserting on its wording would make this a test of the weather. What is
     * asserted is that a question was asked with the file attached, and that
     * something came back and was not a failure.
     */
    const pocket = harness.set(new Pocket());
    const { id, workspace } = await opened();
    showing(pocket, workspace);
    harness.onAbort(() => workspace.dispose());

    await workspace.workspace.create("tutored.py", "def add(a, b):\n    return a - b\n")
      .settled;
    const { root } = await harness.definition("root");
    await until(
      "the file is drawn",
      () => !!rowFor(root, "tutored.py"),
      () => drawn(root).join(" | "),
    );
    await clickRow(rowFor(root, "tutored.py")!);
    await until(
      "the editor handed itself over",
      () => pocket.editor !== undefined,
    );

    const box = root.querySelector(
      "[data-region='assistant'] textarea",
    ) as HTMLTextAreaElement;
    harness.expect(box, "the assistant's prompt box").not.toBeNull();

    await harness.withUserFocus(async (user: any) => {
      await user.click(box);
      await user.type(box, "Is there a bug in add()? One sentence.");
      await user.keyboard("{Enter}");
    });

    const answers = () =>
      [
        ...root.querySelectorAll("[data-region='assistant'] [data-from='assistant']"),
      ] as HTMLElement[];

    await until(
      "the tutor to answer",
      () => (answers().at(-1)?.textContent ?? "").trim().length > 0,
      () =>
        JSON.stringify({
          bubbles: [
            ...root.querySelectorAll("[data-region='assistant'] [data-turn]"),
          ].length,
          failed: !!root.querySelector("[data-region='answer-failed']"),
        }),
      45_000,
    );

    harness
      .expect(root.querySelector("[data-region='answer-failed']"), "it finished")
      .toBeNull();
    /** The question is the person's, and it is on screen above the answer. */
    harness
      .expect(
        root.querySelector("[data-region='assistant'] [data-from='user']")
          ?.textContent,
      )
      .toContain("Is there a bug in add()?");
    void harness.capture("png", tall);

    /**
     * AND IT IS STILL THERE ON A FRESH PAGE.
     *
     * A reload is a new client over the same workspace and a transcript read
     * back from the server, so that is what this does -- twice. First as a
     * plain `Conversation`, which says whether the record survived; then as a
     * whole new shell, which says whether the panel draws it. Without the
     * second, the transcript could be right and the panel still open empty
     * every morning, which is the one thing a record of a conversation must
     * not do.
     */
    const returning = alongside(id, "ada@example.com");
    harness.onAbort(() => returning.dispose());

    const direct = await returning.workspace.tutor.said({ limit: 10 });
    harness
      .expect(
        direct.turns.length,
        `the server's transcript for ${id}: ${JSON.stringify(direct)}`,
      )
      .toBeGreaterThan(0);

    const again = new Conversation();
    again.attach(returning.workspace, (entry: string) => entry);
    await until(
      "the conversation to come back on a fresh client",
      () => again.turns.length >= 2,
      () => JSON.stringify({ turns: again.turns.length, failed: again.failed }),
      20_000,
    );
    harness.expect(again.turns[0]!.text).toContain("Is there a bug in add()?");
    harness.expect(again.turns[1]!.from).toBe("assistant");
    harness.expect(again.turns[1]!.text.length).toBeGreaterThan(0);

    /** And now the panel, on a shell that has never seen this workspace. */
    workspace.dispose();
    pocket.workspace = undefined;
    await harness.delay({ frames: 4 });
    const reopened = alongside(id, "ada@example.com");
    harness.onAbort(() => reopened.dispose());
    showing(pocket, reopened);

    await until(
      "the reopened shell to draw the conversation",
      () =>
        (
          root.querySelector("[data-region='assistant']")?.textContent ?? ""
        ).includes("Is there a bug in add()?"),
      () =>
        (
          root.querySelector("[data-region='transcript-failed']")?.textContent ??
          root.querySelector("[data-region='assistant']")?.textContent ??
          "no assistant panel"
        )
          .replace(/\s+/g, " ")
          .slice(0, 300),
      30_000,
    );
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="stage" bind:this={p.root}>
      {#if p.workspace}
        <Shell
          workspace={p.workspace.workspace}
          liveblocks={live}
          entering={liveRoom.entering}
          onEditor={(editor) => ((p.editor = editor), { dispose: () => {} })}
        />
      {/if}
    </div>
  {/snippet}
</Sweater>
