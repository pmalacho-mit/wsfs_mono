The sample frontend.

A workspace filesystem in a browser: the tree down the left, open files as tabs
in the middle, an assistant down the right, and a terminal under any `.py`
file. Layout is dockview, the tree is `@pierre/trees`, the editor is monaco,
and the terminal runs pyodide. The chrome around all of it is shadcn-svelte,
and the assistant is built from [svelte-ai-elements].

[svelte-ai-elements]: https://svelte-ai-elements.vercel.app/

It reads the client out of `release/frontend` directly rather than out of a
published package, so a change there shows up here without a build step.

    # a database and the sample backend
    docker compose -f ../../tests/compose.yml up -d test-db
    DB_HOST=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' wsfs-tests-test-db-1):5432 \
      PYTHONPATH="../..:../backend" \
      python3 -c "import uvicorn; from app import create_sample_app; uvicorn.run(create_sample_app(), port=8099)"

    # and the page
    npm run dev

Vite proxies `/wsfs` and `/projects` to the backend, so the browser talks to
one origin and nothing here needs CORS.

## The chrome

One palette, in `src/app.css`, and one answer about which way it paints:
`appearance.svelte.ts`. Everything CSS-driven reads the `.dark` class that
mode-watcher puts on the document; the dock, the tree and monaco each want to
be *told*, in their own vocabulary, and that module is where the translation
lives. What decides it is the machine's preference until somebody overrides
it, and their override -- in local storage -- from then on. `src/app.html`
settles it before the first paint, because nothing here renders on a server
and the bundle arrives a frame too late.

`shell/` is the frame: which workspace you are looking at, which course event
it belongs to, and where else you can go.

`assistant/` is the panel on the right. It is handed the paths the person can
see rather than asking for them, which is why the chips above the input say
what a question will carry -- and why `Assistant.svelte` can be looked at, in
a test, with any set of files at all. Nothing behind it sends anywhere yet;
`conversation.svelte.ts` is the seam a transport will fill.

`nudge.ts` is the offer of help that appears when a run ends badly, and
withdraws itself the moment somebody starts typing again -- because somebody
who is editing is no longer stuck.

`textsize.svelte.ts` is the slider on each panel's heading. A workspace is as
often shown as worked in -- an instructor on a laptop, with a room reading the
projection -- and the browser's own zoom is no answer, because it takes the
layout with it. So each panel scales its own text and leaves its width alone,
by declaring `--wsfs-text-scale`; `app.css` restates Tailwind's font sizes
against it, which reaches every utility, shadcn component and rendered answer
underneath without any of them knowing. The two things that cannot be reached
that way are told instead: monaco is handed a font size, because it measures
its own lines to place the caret, and the tree is `zoom`ed, because it is
virtualised and its row heights are arithmetic rather than style.

Three seams are worth reading, because they are the whole point:

`FileTree.svelte` mirrors paths in both directions -- a gesture becomes a
transaction, and the tree's shape is then whatever the effective view says, so
a refused rename snaps back without anybody undoing it.

`Editor.svelte` opens the file's document. While it is open, that document is
the truth: the workspace flushes it on a debounce, and anything reading the
file meanwhile is answered by the document rather than by the last write.

`workspace.svelte.ts` hands the kernel the same filesystem the editor writes
through, which is why `import sibling` finds what is on screen rather than what
was last saved.

## Browser tests

`tests/frontend/*.test.ts` covers the client's logic with no DOM. The rest --
that the tree, the context menu and the editor really drive a workspace --
needs a browser, and lives beside the components as `*.test.svelte`, run by
[sweater-vest-suede](../../sweater-vest-suede/README.md).

The two that drive the workspace are split by one line: **anything that types
is in `Sample.test.svelte`.** The driver opens a tab per file and runs them at
once, and a rename input that loses focus mid-word fails somewhere else
entirely -- so every keyboard gesture shares that file's one serial queue.
`FileTree.test.svelte` is the explorer panel on its own: what its menus offer,
what leaves and enters through them, and whether an open menu is really on top
of the page. It clicks and it hands files to an input; it never types.

The chrome's tests need no backend at all: `offline.ts` answers the wire with
entries to draw and refuses every mutation, which is enough to photograph the
layout and nothing like enough to prove anything about storing.

Two things about the pictures, both learned the hard way. A capture resolves
the palette against the subtree it copies, so a test that wants a dark one
asks for `.dark` **inside** the captured element -- a class further up the
page is one it never sees. And the dock and the tree are painted from `mode`
rather than from that class, so a picture of the whole shell sets both.

```sh
docker compose -f ../compose.yml up -d --build   # the sample host, on :8099
npm run dev                                      # this app, on :5173
npm run test:browser                             # the browser, in a container
```

Assertions land on a SECOND client in the same workspace rather than on the
one under test: a client showing its own optimistic work proves nothing about
what was stored, and a second one only ever sees what the backend streamed
back.

`test:browser` carries `--forward 5173` and a `localhost` server URL, and
**neither is decoration.** The client hashes every queued payload with `crypto.subtle`, which
browsers withhold from insecure origins -- and a browser in a container
reaching this page at the devcontainer's ADDRESS has one. Forwarding publishes
the port on the browser's own loopback, where the origin is trusted. Without
it every test fails, the first of them saying so in as many words.

**The sample stack is on no network of its own**, and that is deliberate: the
report driver finds the devcontainer's network by elimination, so a
compose-created bridge makes that ambiguous and it refuses to start.
`../compose.yml` publishes the database on the default bridge and puts the
backend in the host's namespace instead.
