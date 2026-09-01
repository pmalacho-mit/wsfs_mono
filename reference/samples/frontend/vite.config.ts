import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type UserConfig } from "vite";
import { applyConfig as applyMonacoConfig } from "../../wsfs_suede.python-monaco-suede/config/vite.js";
import { applyConfig as applyKernelConfig } from "../../wsfs_suede.python-web-kernel-suede/config/vite.js";

const BACKEND = process.env.WSFS_BACKEND ?? "http://localhost:8099";

/** This checkout: the siblings are imported from source, and so is the editor's. */
const CHECKOUT = new URL("../../", import.meta.url).pathname;

/**
 * The editor brings its own build requirements -- a language server worker to
 * copy, `PYTHON_MONACO_BASE` to define, and this checkout to allow serving
 * from. Without them monaco mounts and then fails on its first worker, which
 * looks like a file that will not open.
 */
const config = defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  /**
   * ONE COPY OF YJS, and it is not a nicety.
   *
   * The collaboration code ships from `release/`, which is outside this app,
   * so it resolves its dependencies from the checkout's node_modules while
   * everything under `src/` resolves them from this app's. Same versions,
   * different instances -- and a Yjs root type made by one instance is not
   * the type the other one finds under that name. The document then reports
   * a `content` text 24 characters long that renders as the empty string,
   * and the file a client had open comes back blank.
   *
   * Everything listed carries identity across a document: the CRDT itself,
   * the store that reloads one, and the provider that syncs one.
   */
  resolve: {
    dedupe: ["yjs", "y-indexeddb", "@liveblocks/client", "@liveblocks/yjs"],
  },
  server: {
    // Reachable from outside this container, because the browser that runs
    // `npm run test:browser` is in one of its own: `--forward` publishes this
    // port on that browser's localhost by pointing it at THIS machine's
    // address, which the default localhost-only bind does not answer.
    host: true,
    // The editor's own assets live in the checkout's node_modules, several
    // directories above this app. Without this they are served as Forbidden,
    // which monaco reports as a theme it could not load.
    fs: { allow: [CHECKOUT] },
    // The sample talks to the sample backend from the same origin, so nothing
    // here needs CORS and the browser sends the session cookie it would send
    // in a real deployment.
    proxy: {
      "/wsfs": { target: BACKEND, changeOrigin: true },
      "/projects": { target: BACKEND, changeOrigin: true },
      /** Minting room tokens, and where two browsers under test meet. */
      "/liveblocks": { target: BACKEND, changeOrigin: true },
      "/rendezvous": { target: BACKEND, changeOrigin: true },
      /** Asking the host to fill a shared room from the file. */
      "/rooms": { target: BACKEND, changeOrigin: true },
    },
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["pyodide"] },
});

/**
 * Cast because the helper is typed against the copy of vite ITS package
 * resolves, and this app resolves its own -- two installs, structurally the
 * same and nominally different.
 */
const configured = applyKernelConfig(
  applyMonacoConfig(config as Parameters<typeof applyMonacoConfig>[0]),
) as UserConfig;

export default configured;
