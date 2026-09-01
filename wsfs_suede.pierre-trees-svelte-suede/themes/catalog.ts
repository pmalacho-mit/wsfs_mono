import type { TreeThemeInput } from "@pierre/trees";

export type Scheme = "light" | "dark";

export type Load = () => Promise<TreeThemeInput | { default: TreeThemeInput }>;

export type Loaders = Record<Scheme, Record<string, Load>>;

/**
 * The two collections behind https://trees.software/#theming, grouped by the
 * scheme each theme declares. Every specifier is written out because a bundler
 * can only split what it can see — which is what buys a build that carries
 * just the themes it loads.
 *
 * `Theming.test.svelte` fails if either package gains or loses one.
 */
export const pierre = {
  light: {
    "pierre-light": () => import("@pierre/theme/pierre-light"),
    "pierre-light-protanopia-deuteranopia": () => import("@pierre/theme/pierre-light-protanopia-deuteranopia"),
    "pierre-light-soft": () => import("@pierre/theme/pierre-light-soft"),
    "pierre-light-tritanopia": () => import("@pierre/theme/pierre-light-tritanopia"),
    "pierre-light-vibrant": () => import("@pierre/theme/pierre-light-vibrant"),
  },
  dark: {
    "pierre-dark": () => import("@pierre/theme/pierre-dark"),
    "pierre-dark-protanopia-deuteranopia": () => import("@pierre/theme/pierre-dark-protanopia-deuteranopia"),
    "pierre-dark-soft": () => import("@pierre/theme/pierre-dark-soft"),
    "pierre-dark-tritanopia": () => import("@pierre/theme/pierre-dark-tritanopia"),
    "pierre-dark-vibrant": () => import("@pierre/theme/pierre-dark-vibrant"),
  },
} as const satisfies Loaders;

export const shiki = {
  light: {
    "ayu-light": () => import("@shikijs/themes/ayu-light"),
    "catppuccin-latte": () => import("@shikijs/themes/catppuccin-latte"),
    "everforest-light": () => import("@shikijs/themes/everforest-light"),
    "github-light": () => import("@shikijs/themes/github-light"),
    "github-light-default": () => import("@shikijs/themes/github-light-default"),
    "github-light-high-contrast": () => import("@shikijs/themes/github-light-high-contrast"),
    "gruvbox-light-hard": () => import("@shikijs/themes/gruvbox-light-hard"),
    "gruvbox-light-medium": () => import("@shikijs/themes/gruvbox-light-medium"),
    "gruvbox-light-soft": () => import("@shikijs/themes/gruvbox-light-soft"),
    "horizon-bright": () => import("@shikijs/themes/horizon-bright"),
    "kanagawa-lotus": () => import("@shikijs/themes/kanagawa-lotus"),
    "light-plus": () => import("@shikijs/themes/light-plus"),
    "material-theme-lighter": () => import("@shikijs/themes/material-theme-lighter"),
    "min-light": () => import("@shikijs/themes/min-light"),
    "night-owl-light": () => import("@shikijs/themes/night-owl-light"),
    "one-light": () => import("@shikijs/themes/one-light"),
    "rose-pine-dawn": () => import("@shikijs/themes/rose-pine-dawn"),
    "slack-ochin": () => import("@shikijs/themes/slack-ochin"),
    "snazzy-light": () => import("@shikijs/themes/snazzy-light"),
    "solarized-light": () => import("@shikijs/themes/solarized-light"),
    "vitesse-light": () => import("@shikijs/themes/vitesse-light"),
  },
  dark: {
    "andromeeda": () => import("@shikijs/themes/andromeeda"),
    "aurora-x": () => import("@shikijs/themes/aurora-x"),
    "ayu-dark": () => import("@shikijs/themes/ayu-dark"),
    "ayu-mirage": () => import("@shikijs/themes/ayu-mirage"),
    "catppuccin-frappe": () => import("@shikijs/themes/catppuccin-frappe"),
    "catppuccin-macchiato": () => import("@shikijs/themes/catppuccin-macchiato"),
    "catppuccin-mocha": () => import("@shikijs/themes/catppuccin-mocha"),
    "dark-plus": () => import("@shikijs/themes/dark-plus"),
    "dracula": () => import("@shikijs/themes/dracula"),
    "dracula-soft": () => import("@shikijs/themes/dracula-soft"),
    "everforest-dark": () => import("@shikijs/themes/everforest-dark"),
    "github-dark": () => import("@shikijs/themes/github-dark"),
    "github-dark-default": () => import("@shikijs/themes/github-dark-default"),
    "github-dark-dimmed": () => import("@shikijs/themes/github-dark-dimmed"),
    "github-dark-high-contrast": () => import("@shikijs/themes/github-dark-high-contrast"),
    "gruvbox-dark-hard": () => import("@shikijs/themes/gruvbox-dark-hard"),
    "gruvbox-dark-medium": () => import("@shikijs/themes/gruvbox-dark-medium"),
    "gruvbox-dark-soft": () => import("@shikijs/themes/gruvbox-dark-soft"),
    "horizon": () => import("@shikijs/themes/horizon"),
    "houston": () => import("@shikijs/themes/houston"),
    "kanagawa-dragon": () => import("@shikijs/themes/kanagawa-dragon"),
    "kanagawa-wave": () => import("@shikijs/themes/kanagawa-wave"),
    "laserwave": () => import("@shikijs/themes/laserwave"),
    "material-theme": () => import("@shikijs/themes/material-theme"),
    "material-theme-darker": () => import("@shikijs/themes/material-theme-darker"),
    "material-theme-ocean": () => import("@shikijs/themes/material-theme-ocean"),
    "material-theme-palenight": () => import("@shikijs/themes/material-theme-palenight"),
    "min-dark": () => import("@shikijs/themes/min-dark"),
    "monokai": () => import("@shikijs/themes/monokai"),
    "night-owl": () => import("@shikijs/themes/night-owl"),
    "nord": () => import("@shikijs/themes/nord"),
    "one-dark-pro": () => import("@shikijs/themes/one-dark-pro"),
    "plastic": () => import("@shikijs/themes/plastic"),
    "poimandres": () => import("@shikijs/themes/poimandres"),
    "red": () => import("@shikijs/themes/red"),
    "rose-pine": () => import("@shikijs/themes/rose-pine"),
    "rose-pine-moon": () => import("@shikijs/themes/rose-pine-moon"),
    "slack-dark": () => import("@shikijs/themes/slack-dark"),
    "solarized-dark": () => import("@shikijs/themes/solarized-dark"),
    "synthwave-84": () => import("@shikijs/themes/synthwave-84"),
    "tokyo-night": () => import("@shikijs/themes/tokyo-night"),
    "vesper": () => import("@shikijs/themes/vesper"),
    "vitesse-black": () => import("@shikijs/themes/vitesse-black"),
    "vitesse-dark": () => import("@shikijs/themes/vitesse-dark"),
  },
} as const satisfies Loaders;
