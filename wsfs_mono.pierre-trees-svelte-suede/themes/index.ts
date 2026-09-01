import { themeToTreeStyles, type TreeThemeInput } from "@pierre/trees";
import { asDeclarations, asProps } from "../variables";
import type { Variables } from "../variables";
import { pierre, shiki, type Load, type Loaders, type Scheme } from "./catalog";

export type { Scheme };

export type Collection = "pierre" | "shiki";

export type Name =
  | keyof (typeof pierre)["light"]
  | keyof (typeof pierre)["dark"]
  | keyof (typeof shiki)["light"]
  | keyof (typeof shiki)["dark"];

export type Descriptor = {
  name: Name;
  scheme: Scheme;
  collection: Collection;
  displayName: string;
};

/** Words the slug spells one way and a reader expects another. */
const spelling: Record<string, string> = { github: "GitHub", "84": "'84" };

const titled = (word: string) =>
  spelling[word] ?? word.charAt(0).toUpperCase() + word.slice(1);

/** `pierre-dark-soft` → `Pierre Dark Soft`, for a picker that has to say it. */
const displayName = (name: string) =>
  name
    .split("-")
    .map(titled)
    .join(" ")
    .replace("Protanopia Deuteranopia", "Protanopia & Deuteranopia");

const describing = (collection: Collection, source: Loaders) =>
  Object.entries(source).flatMap(([scheme, loaders]) =>
    Object.entries(loaders as Record<string, Load>).map(([name, load]) => ({
      descriptor: {
        name: name as Name,
        scheme: scheme as Scheme,
        collection,
        displayName: displayName(name),
      },
      load,
    })),
  );

const catalog = new Map(
  [
    ...describing("pierre", pierre),
    ...describing("shiki", shiki),
  ].map((entry) => [entry.descriptor.name, entry]),
);

const entry = (name: Name) => {
  const found = catalog.get(name);
  if (!found) throw new Error(`no such theme: ${name}`);
  return found;
};

const matches = (descriptor: Descriptor, filter: Partial<Descriptor>) =>
  (filter.scheme === undefined || descriptor.scheme === filter.scheme) &&
  (filter.collection === undefined ||
    descriptor.collection === filter.collection);

const unwrap = (loaded: TreeThemeInput | { default: TreeThemeInput }) =>
  "default" in loaded ? loaded.default : loaded;

const loaded = new Map<Name, TreeThemeInput>();

/**
 * The catalog behind https://trees.software/#theming — every Pierre and Shiki
 * theme the tree can wear.
 *
 * A separate entry point on purpose: importing the library does not reach it,
 * and importing it only carries the themes actually loaded.
 */
export const themes = {
  all: (filter: Partial<Descriptor> = {}): readonly Descriptor[] =>
    [...catalog.values()]
      .map(({ descriptor }) => descriptor)
      .filter((descriptor) => matches(descriptor, filter)),

  names: (filter: Partial<Descriptor> = {}): readonly Name[] =>
    themes.all(filter).map(({ name }) => name),

  describe: (name: Name): Descriptor => entry(name).descriptor,

  /** The theme itself, fetched once and remembered. */
  async load(name: Name): Promise<TreeThemeInput> {
    const already = loaded.get(name);
    if (already) return already;
    const theme = unwrap(await entry(name).load());
    loaded.set(name, theme);
    return theme;
  },

  /** What a tree wears: `--trees-theme-*` props, ready to spread. */
  async styles(name: Name): Promise<Variables> {
    return asProps(themeToTreeStyles(await themes.load(name)));
  },

  /** The same mapping as a `style` attribute, host colours included. */
  async css(name: Name): Promise<string> {
    return asDeclarations(themeToTreeStyles(await themes.load(name)));
  },
};
