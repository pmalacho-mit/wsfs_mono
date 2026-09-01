import type { DockviewTheme } from "dockview";
import {
  themeDark as dark,
  themeAbyss as abyss,
  themeDracula as dracula,
  themeVisualStudio as vs,
  themeLight as light,
  themeAbyssSpaced as abyssSpaced,
  themeLightSpaced as lightSpaced,
  themeNord as nord,
  themeNordSpaced as nordSpaced,
  themeCatppuccinMocha as catppuccinMocha,
  themeCatppuccinMochaSpaced as catppuccinMochaSpaced,
  themeMonokai as monokai,
  themeSolarizedLight as solarizedLight,
  themeSolarizedLightSpaced as solarizedLightSpaced,
  themeGithubDark as githubDark,
  themeGithubDarkSpaced as githubDarkSpaced,
  themeGithubLight as githubLight,
  themeGithubLightSpaced as githubLightSpaced,
} from "dockview";

const themes = {
  dark,
  abyss,
  dracula,
  vs,
  light,
  abyssSpaced,
  lightSpaced,
  nord,
  nordSpaced,
  catppuccinMocha,
  catppuccinMochaSpaced,
  monokai,
  solarizedLight,
  solarizedLightSpaced,
  githubDark,
  githubDarkSpaced,
  githubLight,
  githubLightSpaced,
};

export default themes;

export type Theme = keyof typeof themes;

export const themeOptions = Object.keys(themes) as Theme[];

/**
 * A theme is either one this library names, or one the consumer builds
 * themselves — the only way to reach settings like `tabAnimation`, which
 * stopped being a top-level dockview option.
 */
export type ThemeSetting = Theme | DockviewTheme;

export const resolveTheme = (setting: ThemeSetting): DockviewTheme =>
  typeof setting === "string" ? themes[setting] : setting;
