/** A point, as the menu's anchoring wants it: a box with no size. */
export const pointAsRect = (x: number, y: number) => ({
  top: y,
  bottom: y,
  left: x,
  right: x,
  width: 0,
  height: 0,
  x,
  y,
});

/**
 * Something to undo, however whoever made it spells that.
 *
 * Structural rather than an editor's `IDisposable`: this package must not know
 * which editor is in use, and the shape is one method.
 */
type Disposable = { dispose: () => void };

type Cleanup = Disposable | (() => void);

export const cleaner = () => {
  const cleanup = Object.assign(
    () => {
      for (const entry of cleanup.set)
        typeof entry === "function" ? entry() : entry.dispose();
      cleanup.set.clear();
    },
    {
      set: new Set<Cleanup>(),
      add: (...entries: Cleanup[]) =>
        entries.forEach((entry) => cleanup.set.add(entry)),
    },
  );

  return cleanup;
};
