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
      // A prefix of its own for each package: `$lib/...` is resolved by
      // SvelteKit against src/lib before any alias here is consulted, and
      // naming the five packages is what makes an import in this app say
      // which side of the split it is reaching for.
      $wsfs: suede("wsfs_core_suede/frontend"),
      $svelte: suede("wsfs_svelte_suede/frontend"),
      $python: suede("wsfs_python_suede/frontend"),
      $assistant: suede("wsfs_assistant_suede/frontend"),
      $pytutor: suede("wsfs_pytutor_suede/frontend"),
      // Root-owned, one folder per dependency and one name for it. The
      // per-consumer edge names suede creates by default would give the same
      // file two paths, and TypeScript reads two paths as two nominal types --
      // which shows up as a `TextSize` from one package not being the
      // `TextSize` the next one declares. See each package's README.
      "pierre-trees-svelte-suede": suede("pierre-trees-svelte-suede"),
      "dockview-svelte-suede": suede("dockview-svelte-suede"),
      "python-monaco-suede": suede("python-monaco-suede"),
      "with-events-suede": suede("with-events-suede"),
      "python-web-kernel-suede": suede("python-web-kernel-suede"),
      "sweater-vest-suede": suede("sweater-vest-suede"),
    },
  },
};
