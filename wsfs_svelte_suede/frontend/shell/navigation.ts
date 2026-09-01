/**
 * Where the header's nav can take you, and the fact that this package cannot
 * say.
 *
 * A destination is a label, an icon and something to do -- and what a "Home"
 * button does is the host's router's business, not this package's. So this
 * ships the SHAPE and an empty list; a host passes its own through the
 * header's `destinations` prop.
 *
 * It used to import SvelteKit's `goto` and keep three commented-out entries
 * against the day somebody wanted them back. That is a host framework welded
 * into a UI library for the sake of code nobody runs, which is exactly the
 * kind of edge the split exists to remove.
 */
import type { Icon } from "@lucide/svelte";

export type Destination = {
  label: string;
  icon: typeof Icon;
  go: () => void;
};

/** What this package knows about on its own, which is nothing. */
export const navigation: Destination[] = [];
