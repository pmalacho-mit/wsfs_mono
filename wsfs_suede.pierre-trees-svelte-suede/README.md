# pierre-trees-svelte-suede

> [!NOTE]
> This is a [suede](https://github.com/pmalacho-mit/suede) dependency.

A Svelte 5 wrapper around [`@pierre/trees`](https://trees.software/) — the
path-first, virtualized file tree from the Pierre team.

`@pierre/trees` already owns the hard parts: a path-keyed store, virtualized
rendering into a shadow root, search, drag and drop, inline renaming, git status
and icons. What it does not have is a Svelte face. This library adds that and
gets out of the way:

- **`Tree.Model`** — a TypeScript class that owns a `FileTree` and republishes
  the parts you would otherwise have to poll (`focus`, `selection`, `search`,
  `rows`) as Svelte state, plus a typed `subscribe` for everything that happens.
- **`Tree.Component`** — mounts a model into a `<file-tree-container>`, fills the
  tree's `header` and `context-menu` slots from Svelte snippets, and takes every
  `--trees-*` custom property as a typed prop.
- **`ContextMenu`** — the menu most explorers want, already wired to the tree.
  Use it, extend its actions, or ignore it: nothing else depends on it, so a
  build that never imports it never ships it.

Anything not mirrored here is one property away: `model.tree` is the underlying
`FileTree` instance, unwrapped.

---

## Contents

1. [Getting started](#1-getting-started)
2. [`Tree.Model`](#2-treemodel)
3. [`Tree.Component`](#3-treecomponent)
4. [Styling](#4-styling)
5. [`ContextMenu`](#5-contextmenu)
6. [Events](#6-events)
7. [Themes](#7-themes)
8. [Input, icons, density](#8-input-icons-density)
9. [Types](#9-types)

---

## 1. Getting started

```svelte
<script lang="ts">
  import { Tree } from "<path>/pierre-trees-svelte-suede";

  const model = new Tree.Model({
    paths: ["README.md", "src/index.ts", "src/components/Button.svelte"],
    initialExpansion: "open",
  });
</script>

<Tree.Component {model} style="height: 320px;" />

<p>Selected: {model.selection.paths.join(", ")}</p>
```

The host element has no height of its own, so give it one — through `style`,
`class`, or a sized parent.

`Tree.Model` takes `@pierre/trees`' `FileTreeOptions` unchanged, so every option
in the upstream docs works here. Reach for `model.dispose()` when a model
outlives the component that rendered it.

---

## 2. `Tree.Model`

### Reactive state

Reading any of these inside an effect, a `$derived`, or markup re-runs when the
tree changes. They are refreshed from a single subscription to the tree, so
there is nothing to poll and nothing to invalidate.

| Read                    | Type                     |
| ----------------------- | ------------------------ |
| `model.selection.paths` | `readonly string[]`      |
| `model.focus.path`      | `string \| null`         |
| `model.focus.index`     | `number`                 |
| `model.search.isOpen`   | `boolean`                |
| `model.search.value`    | `string`                 |
| `model.search.matches`  | `readonly string[]`      |
| `model.rows.count`      | `number`                 |

### Structure

```ts
model.add("src/main.ts");
model.remove("src/legacy/", { recursive: true });
model.move("src/components/", "src/ui/", { collision: "skip" });
model.batch([
  { type: "add", path: "docs/guide.md" },
  { type: "move", from: "README.md", to: "docs/README.md" },
]);
model.reset(["a.txt", "b/c.txt"]);
model.reset({ preparedInput });
```

Removing a populated directory needs `{ recursive: true }`. A `move` carries
every descendant with it. A `batch` reaches subscribers as one event.

### Rows

`rows` is the visible projection — what expansion, flattening and search have
left on screen, not the raw path list.

```ts
model.rows.count; // reactive
model.rows.slice(0, 19); // both ends inclusive, both clamped
model.rows.all();
model.rows.paths();
model.rows.names();
```

### Focus

```ts
model.focus.at("src/index.ts");
model.focus.first();
model.focus.last();
model.focus.next();
model.focus.previous();
model.focus.parent();
model.focus.nearest("src/deleted.ts"); // → the closest surviving path
model.focus.item; // the item handle, or null
```

### Selection

```ts
model.selection.add("README.md");
model.selection.remove("README.md");
model.selection.toggle("README.md");
model.selection.only("README.md");
model.selection.clear();
model.selection.has("README.md");
```

### Search

Search is a session: `set(value)` opens one, `set(null)` ends it. What happens
to non-matching rows is `fileTreeSearchMode`, which defaults to
`hide-non-matches`.

```ts
model.search.set("button");
model.search.matches; // ["src/components/Button.svelte"]
model.search.focusNext(); // clamps at the last match, does not wrap
model.search.focusPrevious();
model.search.close();
```

Passing `search: true` to the constructor also renders the tree's own search
input; `searchBlurBehavior` then decides whether clicking away ends the session.

### Items

```ts
const item = model.item("src/components/"); // bare "src/components" works too
if (item?.isDirectory()) item.toggle();
```

`isDirectory()` narrows the handle, so `expand`, `collapse`, `toggle` and
`isExpanded` only typecheck where they exist.

### Drops on the root

The tree resolves a drop target from the ROW under the pointer: a folder row is
that folder, a file row is the folder holding it, and a row that already lives
at the top level is the root. Empty space is no row, so a file inside a
directory has nowhere to be dropped that would take it out of one.

So the model makes the tree's own surface — anything below the last row, and
the header — mean the root:

```ts
new Tree.Model({ paths, dragAndDrop: true }); // on, wherever dragAndDrop is
new Tree.Model({ paths, dragAndDrop: true, dropOnRoot: false }); // off
```

`src/lib/utils.ts` dropped there becomes `utils.ts`, and a folder carries its
contents with it. It is the tree's own drop in every other respect: `canDrag`
still decides whether the drag starts, `canDrop` is asked with
`target.kind === "root"`, a name the root is already using is refused before
anything moves, and the outcome arrives as [`dropped` or `drop
refused`](#6-events) like any other. `dropOnRoot` is the one option
`Tree.Model` takes that is not `@pierre/trees`'.

While a drop would land on the root, the host carries `data-root-drop-target` —
which draws a ring in the tree's own focus colour, and is there to hang a rule
of your own on:

```css
file-tree-container[data-root-drop-target] {
  /* or move the built-in one with --trees-root-drop-ring-color, --trees-root-drop-bg */
}
```

### The rest

```ts
model.rename("src/index.ts"); // no argument renames the focused row
model.scrollTo("pkg/1500/file.ts", { focus: true, offset: "center" });
model.git.set([{ path: "README.md", status: "modified" }]);
model.git.patch({ set: [...], remove: ["src/index.ts"] });
model.setIcons({ set: "standard", byFileExtension: { svelte: "flame" } });
model.mount(element); // returns the unmount function
model.dispose();
```

`rename` only does anything when the model was built with `renaming`, and only
for a row that is currently on screen.

---

## 3. `Tree.Component`

```svelte
<Tree.Component {model} class="explorer" style="height: 100%;">
  {#snippet header()}
    <strong>{project.name}</strong>
  {/snippet}

  {#snippet contextMenu(item, context)}
    <menu>
      <button onclick={() => { open(item.path); context.close(); }}>
        Open {item.name}
      </button>
    </menu>
  {/snippet}
</Tree.Component>
```

| Prop           | Type                                                    |
| -------------- | ------------------------------------------------------- |
| `model`        | `Tree.Model` — required                                 |
| `header`       | `Snippet` — fills the tree's header slot                |
| `contextMenu`  | `Snippet<[item, context]>` — fills the menu slot         |
| `--trees-*`    | `string` — every custom property the tree reads, see [Styling](#4-styling) |
| …rest          | any `HTMLAttributes<HTMLElement>`, spread on the host    |

Both snippets render in the light DOM and are slotted into the tree's shadow
root, which is why they stay ordinary, reactive Svelte. Supplying `header`
replaces `composition.header`; supplying `contextMenu` enables the context menu
and replaces `composition.contextMenu.render`, leaving the rest of that
configuration (`triggerMode`, `buttonVisibility`, `onOpen`, `onClose`) alone.

`context.close()` unmounts the menu, so the snippet controls its own lifetime.

---

## 4. Styling

Every custom property `@pierre/trees` reads is an optional `string` prop, so an
editor offers them and a typo is a type error:

```svelte
<Tree.Component
  {model}
  --trees-bg-override="oklch(20.5% 0 0)"
  --trees-selected-bg-override="oklch(35% 0.08 250)"
  --trees-font-size-override="13px"
/>
```

Svelte compiles `--x="y"` on a component into an inherited declaration rather
than a prop, which is why declaring them buys typing rather than behaviour. They
also work spread from an object, in which case they land on the host inline:

```svelte
<script lang="ts">
  const dark: Tree.Style = {
    "--trees-bg-override": "oklch(20.5% 0 0)",
    "--trees-fg-override": "oklch(98.5% 0 0)",
  };
</script>

<Tree.Component {model} {...dark} />
```

The list is the properties the stylesheet reads without declaring — the holes
it leaves open — plus `--trees-root-drop-ring-color` and `--trees-root-drop-bg`,
which are this wrapper's own, for the [drop zone](#drops-on-the-root) it draws
itself. Two groups are deliberately absent:

- **Resolved values** (`--trees-bg`, `--trees-fg`, the per-language icon
  palette). The sheet declares these on `:host`, so an inherited value would
  lose to its own rule. Use the matching `-override`, or `unsafeCSS`.
- **`--trees-item-height` and `--trees-density-override`.** The component writes
  both from the model; `density` and `itemHeight` in the options move them.

`Tree.Style` is the whole set as a type, and `Tree.Variable` is the union of
names.

---

## 5. `ContextMenu`

The menu most file explorers want, ready for the `contextMenu` snippet: the
surface, keyboard navigation, edge flipping, and the four standard actions.

```svelte
<script lang="ts">
  import { ContextMenu, Tree } from "<path>/pierre-trees-svelte-suede";

  const model = new Tree.Model({ paths, renaming: true });
</script>

<Tree.Component {model}>
  {#snippet contextMenu(item, context)}
    <ContextMenu.Component
      {context}
      actions={ContextMenu.actions({ model, item, context })}
    />
  {/snippet}
</Tree.Component>
```

`ContextMenu.actions` returns **New file**, **New folder**, **Rename** and
**Delete**, already wired — new entries land inside a directory and beside a
file, and open straight into rename mode. Nothing about it is privileged: it
returns a plain `ContextMenu.Action[]`, so extend it, reorder it, or replace it:

```ts
const actions = [
  ...ContextMenu.actions({ model, item, context }),
  { label: "Copy path", divided: true, run: () => copy(item.path) },
];
```

| `Action` field | Meaning                                     |
| -------------- | ------------------------------------------- |
| `label`        | What the item reads                         |
| `run`          | What it does                                |
| `danger`       | Draws it in the destructive colour          |
| `divided`      | Draws a divider above it                    |

`entries` holds the mutations the standard actions are made of —
`entries.add(model, item, "file" \| "folder")`, `entries.rename(model, item)`,
`entries.remove(model, item)` — for building actions of your own.

### It wears whatever the tree is wearing

Every colour chains through the tree's own resolved variables before reaching a
default, so a [theme](#7-themes) or a `--trees-*-override` palette carries into
the menu with nothing to wire up:

| The menu's        | comes from                                              |
| ----------------- | ------------------------------------------------------- |
| background        | `--trees-search-bg` — a menu is a raised surface, like the search field, which is the one colour a palette is free to make transparent |
| text              | `--trees-search-fg`                                     |
| border, divider   | `--trees-border-color`                                  |
| hover             | `--trees-bg-muted`                                      |
| destructive       | `--trees-status-deleted`, the theme's git-deleted red    |
| radius, font      | `--trees-border-radius`, `--trees-font-family`, `--trees-font-size` |

That works because the tree declares those on `:host` and the menu is slotted
from the host's light DOM, so they inherit. Outside a tree it falls back to a
neutral surface that follows the page's `color-scheme`.

Each is still overridable — `--trees-menu-bg`, `--trees-menu-fg`,
`--trees-menu-border-color`, `--trees-menu-hover-bg`, `--trees-menu-danger-fg`,
`--trees-menu-border-radius`, `--trees-menu-shadow`, `--trees-menu-min-width`,
`--trees-menu-font-family`, `--trees-menu-font-size` — typed as
`ContextMenu.Style`, and props the same way the tree's are.

It needs no coordinates: the tree slots it into an anchor element it has already
positioned over the row, so the menu only says which corner of that anchor to
hang from. Give the host no `overflow` if you want an open menu to be allowed
past the panel's edge.

---

## 6. Events

`model.subscribe(handlers)` takes a map and returns one unsubscribe for all of
it. Handlers are fully typed by event name.

```ts
const stop = model.subscribe({
  added: ({ path }) => log(`+ ${path}`),
  removed: ({ path, recursive }) => log(`- ${path}`),
  moved: ({ from, to }) => log(`${from} → ${to}`),
  reset: ({ pathCountBefore, pathCountAfter }) => log("reset"),
  batched: ({ events }) => log(`${events.length} at once`),
  mutated: ({ operation }) => log(operation),
  "selection changed": (paths) => log(paths),
  "focus changed": (path) => log(path),
  "search changed": (value) => log(value),
  renamed: ({ sourcePath, destinationPath }) => log("renamed"),
  "rename refused": (error) => log(error),
  dropped: ({ draggedPaths, target }) => log("dropped"),
  "drop refused": (error, context) => log(error),
});
```

`renamed` / `rename refused` need `renaming` enabled, and `dropped` /
`drop refused` need `dragAndDrop` enabled — the model relays the upstream
callbacks rather than replacing them, so a config that already supplies
`onRename` or `onDropComplete` keeps working.

---

## 7. Themes

`themes` is the catalog behind [trees.software's theming
section](https://trees.software/#theming) — every Pierre and Shiki theme, 75 of
them, each behind its own dynamic import.

It is a **separate entry point**, so importing the library never reaches it and
importing it only carries the themes actually loaded:

```svelte
<script lang="ts">
  import { Tree } from "<path>/pierre-trees-svelte-suede";
  import { themes } from "<path>/pierre-trees-svelte-suede/themes";

  const model = new Tree.Model({ paths });
  let wearing = $state("dracula" as const);
</script>

{#await themes.styles(wearing) then style}
  <Tree.Component {model} {...style} />
{/await}
```

| Call                    | Gives                                                          |
| ----------------------- | -------------------------------------------------------------- |
| `themes.names(filter?)` | Theme names, optionally by `scheme` or `collection`             |
| `themes.all(filter?)`   | The same as descriptors — `name`, `scheme`, `collection`, `displayName` |
| `themes.describe(name)` | One descriptor, for the row of a picker                        |
| `themes.load(name)`     | The theme itself, fetched once and remembered                  |
| `themes.styles(name)`   | `Tree.Style` — the `--trees-theme-*` props, ready to spread     |
| `themes.css(name)`      | The same as a `style` attribute, host colours included          |

Names are a literal union, so `themes.load("draclua")` is a type error rather
than a runtime one. A picker is `themes.all({ scheme: "dark" })`.

For a theme you already have — one resolved by Shiki yourself, or written by
hand — `theme` is the same mapping without the catalog:

```ts
theme.props(source); // Tree.Style, to spread
theme.css(source); // a style attribute string
theme.styles(source); // the raw themeToTreeStyles result
```

Both routes end in the tree's own `--trees-theme-*` variables, which is why a
theme reaches everything that reads them — including the
[context menu](#5-contextmenu).

---

## 8. Input, icons, density

```ts
import { density, icons, input } from "<path>/pierre-trees-svelte-suede";

const prepared = input.prepare(paths, { flattenEmptyDirectories: false });
const presorted = input.presorted(alreadySortedPaths);

icons.spriteSheet("standard"); // the built-in <symbol> markup
icons.resolver(config).resolveIcon("file-tree-icon-file", "src/App.svelte");

density.presets.compact.itemHeight;
density.defaultItemHeight;
```

Preparing input sorts and flattens once, so the same result can seed many trees
or many resets.

---

## 9. Types

Everything hangs off the `Tree` namespace, so one import covers the surface:

```ts
import type { Tree } from "<path>/pierre-trees-svelte-suede";

let model: Tree.Model;
let options: Tree.Options;
let handlers: Tree.Handlers;
let row: Tree.Row;
let item: Tree.Item; // Tree.Directory | Tree.File
let mode: Tree.SearchMode;
```

`Tree.Events` is the event map itself, so `Tree.Events["renamed"][0]` names the
payload of a single event without importing from `@pierre/trees` directly.
