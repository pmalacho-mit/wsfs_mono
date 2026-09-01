# python-monaco-suede

A Monaco editor for Python in the browser, with
[basedpyright](https://github.com/detachhead/basedpyright) running in a worker
for intellisense. Typeshed is bundled into that worker, so there is no stub
download at startup.

```svelte
<script lang="ts">
  import { Editor } from "<path>/python-monaco-suede";

  const file = new Editor.Model({
    name: "main.py",
    parent: { path: "/" },
    source: "print('hello')",
  });
</script>

<Editor.Component {file} />
```

---

## Bringing your own filesystem

`Editor.registerFile` copies content into the editor. If you already keep the
workspace somewhere else, hand over a `FileProvider` instead and nothing is
copied:

```ts
const unmount = await Editor.provideFiles({
  paths: () => myVfs.list(), // every path, so imports resolve
  read: (path) => myVfs.read(path), // called only when something needs it
  write: (path, text) => myVfs.write(path, text), // optional
  watch: (listen) => myVfs.subscribe(listen), // optional
});
```

`paths()` is the only thing read eagerly, and only the paths — never content.
From then on:

- The **editor's filesystem** registers one lazy node per path. `read(path)`
  runs when a document is opened, and the result is cached until `watch`
  reports the file changed.
- The **language server** is fed on demand. Opening a file delivers that file
  plus its import closure and nothing else, so `unopened.py` in a thousand-file
  workspace is never fetched. Adding a file makes previously unresolved imports
  resolve; removing one retracts it from the server.

`watch` reports `{ path, kind: "added" | "changed" | "removed" }`. Without it,
the editor assumes the set of files never changes after mount.

### Why the server still receives content

The server's filesystem lives inside its worker and is synchronous — import
resolution calls `readFileSync` during type evaluation, so there is no callback
it could await. What the demand loader buys is that content crosses that
boundary once, only for modules actually reachable from an open file.

Mechanically, a dependency is delivered in two steps: `pyright/createFile` makes
the path exist so imports resolve, and a `textDocument/didOpen` supplies the
content, because that notification only ever creates an empty file. Versions and
the open-versus-change decision are settled in one place —
`language/documents.ts` — since the editor delivers content the same way and
whichever arrives second must change the document rather than reopen it.

A genuinely pull-based server would need a synchronous bridge into the worker
(`SharedArrayBuffer` + `Atomics.wait`, which needs cross-origin isolation) and a
custom server build.

---

## Chained documents

A notebook cell is analysed as its own document with every earlier cell in
front of it — the same chaining VSCode uses to make a name bound in one cell
visible in the next. Nothing here is specific to notebooks: hand over an
ordered list of files and they share one namespace.

```ts
import { Chained, Editor } from "<path>/python-monaco-suede";

const files = [
  new Editor.Model({ name: "1.py", parent: chain, source: "greeting = 'hello'" }),
  new Editor.Model({ name: "2.py", parent: chain, source: "greeting.upper()" }),
];

const chain = { path: "/lesson", files };

const unregister = Chained.register(chain);
```

`files` is read on every query rather than copied, so the list may be reordered,
added to and removed from in place. When one file's text changes, tell the
server that the files after it need analysing again:

```ts
await Chained.resyncAfter(chain, edited);
```

Debounce that: a keystroke in the first of twenty cells otherwise resends
nineteen documents.

Positions are translated in both directions at the protocol level, so:

- Hover and completion in a later file resolve names from earlier ones.
- Go-to-definition on such a name lands in the file that owns it, not on a
  phantom line in the current one.
- A mistake in file 1 is reported on file 1 only, never repeated on file 2.
- Resends carry versions from the same counter the import loader uses, since
  the editor is not the only author of a chained file's text.

The cost is quadratic in chain length: file *n*'s document contains *n* files'
worth of text.

The server can also chain notebook cells itself, over `notebookDocument/didOpen`
with `vscode-notebook-cell:` URIs, which would remove the rewriting layer
entirely. That needs cell models to carry that URI scheme, so it is not what
this does today.

### Displaying and running a notebook

This package deliberately stops at "Python in a Monaco editor". Rendering a
notebook — cell ordering, markdown, outputs, execution against a kernel, and
optional collaborative editing — is
[python-notebook-suede](https://github.com/pmalacho-mit/python-notebook-suede),
which builds its cell chain out of the API above.

### With a python web kernel

[python-web-kernel-suede](https://github.com/pmalacho-mit/python-web-kernel-suede)
runs pyodide in a worker and mounts a filesystem you supply on the main thread,
reaching it synchronously from inside the worker. That filesystem is the same
idea as a `FileProvider`, so one definition can serve both:

```ts
import Kernel from "<path>/python-web-kernel-suede";
import { Editor, WebKernel } from "<path>/python-monaco-suede";

const files = {
  get: (path) => myVfs.read(path),
  listDirectory: (path) => myVfs.entries(path),
  put: (path, value) => myVfs.write(path, value),
};

const kernel = new Kernel(
  Kernel.Environment({ fs: Kernel.ReadWriteFileSystem(files) }),
);

await Editor.provideFiles(WebKernel.provider(files));
```

`WebKernel.filesystem` goes the other way, for a `FileProvider` you already
have. It reads synchronously, because the kernel blocks the worker waiting for
an answer and cannot await one.

The result is one copy of a file: the editor and the interpreter read the same
bytes, and running the code cannot disagree with the intellisense describing it.

Third-party packages are the exception. They live in the pyodide worker's own
filesystem, which the main thread cannot walk, so `import numpy` resolves only
as far as the stubs typeshed bundles. Getting the installed versions in front of
the language server would mean having the kernel copy its `site-packages` into
the shared filesystem, which this does not do.

---

## Configuration

```ts
Editor.configure({
  typeCheckingMode: "strict",
  diagnosticSeverityOverrides: { reportMissingImports: "warning" },
});
```

These answer the server's `workspace/configuration` requests. Note that
basedpyright asks for the `python` and `basedpyright` sections and reads
`.analysis` off the result, where pyright asked for `python.analysis` directly —
answering the wrong shape leaves every type silently inferred as `Unknown`
rather than raising anything.

`browser-basedpyright` is pinned exactly. It publishes very frequently and warns
that builds are not guaranteed to work outside its own playground, so treat a
version bump as a change to test rather than to take.
