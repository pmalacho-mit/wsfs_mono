import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// The DIRECTORY, not its index: `fs` and friends live in sibling modules
// that the package does not re-export, so subpath imports have to resolve.
const suede = (name) => new URL(`../../${name}`, import.meta.url).pathname;

export default {
  preprocess: vitePreprocess(),
  kit: {
    // A workspace lives in the browser, so this is a single page that
    // talks to the sample backend -- nothing here renders on a server.
    adapter: adapter({ fallback: "index.html" }),
    alias: {
      $lib: "src/lib",
      // A prefix of its own: `$lib/...` is resolved by SvelteKit against
      // src/lib before any alias here is consulted.
      $wsfs: new URL("../../release/frontend/index.ts", import.meta.url)
        .pathname,
      "wsfs_suede.pierre-trees-svelte-suede": suede(
        "wsfs_suede.pierre-trees-svelte-suede",
      ),
      "wsfs_suede.dockview-svelte-suede": suede(
        "wsfs_suede.dockview-svelte-suede",
      ),
      "wsfs_suede.python-monaco-suede": suede("wsfs_suede.python-monaco-suede"),
      "wsfs_suede.with-events-suede": suede("wsfs_suede.with-events-suede"),
      "wsfs_suede.python-web-kernel-suede": suede(
        "wsfs_suede.python-web-kernel-suede",
      ),
      "sweater-vest-suede": suede("sweater-vest-suede"),
    },
  },
};
