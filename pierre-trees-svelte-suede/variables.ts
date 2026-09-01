/**
 * Every custom property `@pierre/trees`' stylesheet reads without ever
 * declaring one of its own — the holes it deliberately leaves open.
 *
 * They are listed here as component props so an editor can offer them, and
 * because Svelte turns `--x="y"` on a component into an inherited declaration
 * rather than a prop. Anything the stylesheet declares itself (the resolved
 * `--trees-bg`, the per-language icon palette) is absent: a value inherited
 * from outside would lose to the sheet's own `:host` rule.
 *
 * `--trees-item-height` and `--trees-density-override` are absent for a
 * different reason — the component writes both from the model, so `density`
 * and `itemHeight` in the options are how you move them.
 *
 * The two `--trees-root-drop-*` are the exception: the sheet has never heard
 * of them, because the drop zone they colour is this wrapper's own.
 */
export type Variables = Partial<{
  // Surface and text
  "--trees-accent-override": string;
  "--trees-bg-override": string;
  "--trees-bg-muted-override": string;
  "--trees-bg-alpha-light": string;
  "--trees-bg-alpha-dark": string;
  "--trees-fg-override": string;
  "--trees-fg-muted-override": string;
  "--trees-border-color-override": string;
  "--trees-indent-guide-bg-override": string;

  // Typography
  "--trees-font-family-override": string;
  "--trees-font-size-override": string;
  "--trees-font-weight-regular-override": string;
  "--trees-font-weight-semibold-override": string;

  // Metrics — most of these default to a multiple of the density factor
  "--trees-border-radius-override": string;
  "--trees-gap-override": string;
  "--trees-level-gap-override": string;
  "--trees-item-margin-x-override": string;
  "--trees-item-padding-x-override": string;
  "--trees-item-row-gap-override": string;
  "--trees-padding-inline-override": string;
  "--trees-icon-width-override": string;
  "--trees-icon-nudge-override": string;
  "--trees-action-lane-width-override": string;
  "--trees-git-lane-width-override": string;

  // Focus ring
  "--trees-focus-ring-color-override": string;
  "--trees-focus-ring-width-override": string;
  "--trees-focus-ring-offset-override": string;

  // The one thing this wrapper draws itself: the host while a drop on it
  // would land at the root. Both default to the tree's focus ring.
  "--trees-root-drop-ring-color": string;
  "--trees-root-drop-bg": string;

  // Selection
  "--trees-selected-bg-override": string;
  "--trees-selected-fg-override": string;
  "--trees-selected-focused-border-color-override": string;

  // Search input
  "--trees-input-bg-override": string;
  "--trees-search-bg-override": string;
  "--trees-search-fg-override": string;
  "--trees-search-font-weight-override": string;

  // Scrollbar
  "--trees-scrollbar-gutter-override": string;
  "--trees-scrollbar-thumb-override": string;

  // Git status — `status-*` colours the letter, `git-*-color` colours the row
  "--trees-status-added-override": string;
  "--trees-status-deleted-override": string;
  "--trees-status-ignored-override": string;
  "--trees-status-modified-override": string;
  "--trees-status-renamed-override": string;
  "--trees-status-untracked-override": string;
  "--trees-git-added-color-override": string;
  "--trees-git-deleted-color-override": string;
  "--trees-git-ignored-color-override": string;
  "--trees-git-modified-color-override": string;
  "--trees-git-renamed-color-override": string;
  "--trees-git-untracked-color-override": string;

  // Icons — one colour for every file icon, plus the two the palette misses
  "--trees-file-icon-color": string;
  "--trees-file-icon-cyan": string;
  "--trees-file-icon-vermilion": string;

  // What `theme.styles` fills in from a Shiki or VS Code theme
  "--trees-theme-sidebar-bg": string;
  "--trees-theme-sidebar-fg": string;
  "--trees-theme-sidebar-border": string;
  "--trees-theme-sidebar-header-fg": string;
  "--trees-theme-list-active-selection-bg": string;
  "--trees-theme-list-active-selection-fg": string;
  "--trees-theme-list-hover-bg": string;
  "--trees-theme-input-bg": string;
  "--trees-theme-input-fg": string;
  "--trees-theme-focus-ring": string;
  "--trees-theme-scrollbar-thumb": string;
  "--trees-theme-git-added-fg": string;
  "--trees-theme-git-deleted-fg": string;
  "--trees-theme-git-ignored-fg": string;
  "--trees-theme-git-modified-fg": string;
  "--trees-theme-git-renamed-fg": string;
  "--trees-theme-git-untracked-fg": string;
}>;

export type VariableName = keyof Variables;

const isVariable = (name: string): name is VariableName => name.startsWith("--");

type Entries = [name: string, value: unknown][];

/** Splits rest props into the custom properties and everything else. */
export const partition = (rest: Record<string, unknown>) => {
  const entries = Object.entries(rest) as Entries;
  return {
    declarations: entries.filter(([name]) => isVariable(name)),
    attributes: Object.fromEntries(entries.filter(([name]) => !isVariable(name))),
  };
};

export const asStyle = (
  declarations: Entries,
  existing?: string | null,
): string | undefined => {
  const text = [
    existing,
    ...declarations.map(([name, value]) => `${name}: ${String(value)}`),
  ]
    .filter(Boolean)
    .join("; ");
  return text.length === 0 ? undefined : text;
};

/** `themeToTreeStyles` speaks React's camelCase style keys; CSS text needs kebab-case. */
const cssProperty = (key: string): string =>
  key.startsWith("--")
    ? key
    : key.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`);

/** A `themeToTreeStyles` result as a `style` attribute, host colours included. */
export const asDeclarations = (styles: Record<string, string>): string =>
  Object.entries(styles)
    .filter(([, value]) => value !== "")
    .map(([property, value]) => `${cssProperty(property)}: ${value}`)
    .join("; ");

/** The same result as component props — only the custom properties are ones. */
export const asProps = (styles: Record<string, string>): Variables =>
  Object.fromEntries(
    Object.entries(styles).filter(([property]) => isVariable(property)),
  );
