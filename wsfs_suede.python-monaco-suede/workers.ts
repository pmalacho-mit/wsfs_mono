/// <reference types="vite/client" />
/// <reference path="./globals.d.ts" />

/** @see config/vite.js for how the server worker is copied to the static assets folder */
export const newServerWorker = () =>
  new Worker(
    new URL(PYTHON_MONACO_BASE + "pyright.worker.js", window.location.href),
  );
