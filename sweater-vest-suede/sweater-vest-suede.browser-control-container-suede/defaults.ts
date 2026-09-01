import type { Browser } from ".";

const defaults = {
  container: (browser: Browser) => `browser-control-${browser}`,
  image: (browser: Browser) => `${defaults.container(browser)}:latest`,
  /** Idles so the container stays up, and serves any ports being forwarded. */
  command: ["node", "/forward.mjs"],
};

export default defaults;
