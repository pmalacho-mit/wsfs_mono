import type { Kernel } from "../worker/kernel-worker";
import { EMFS } from "../worker/emscripten-fs";
import {
  patchMatplotlib,
  unloadLocalModules,
  asImage,
  tryResolveProblematicDependencies,
  loadMsgFilterAndCollectPackages,
  tryLoadImportsOfLocallyImportedModules,
  addToSysPath,
} from "./modules";
import { loadPyodide, version, type PyodideAPI } from "pyodide";
import { make, type Output } from "../output";
import { dirname } from "../utils";

const Char = {
  NewLine: 10,
} as const;

/**
 * Serves some properties from a local object instead of the proxied one. Purely
 * local: nothing here crosses to the other thread.
 */
const wrapExcluder = <T extends object>(
  proxied: T,
  local: T,
  exclude: Set<string | symbol>,
): T =>
  new Proxy<T>(proxied, {
    get(target, prop, receiver) {
      if (exclude.has(prop)) target = local;

      const value = Reflect.get(target, prop, receiver);

      if (typeof value !== "function") return value;
      return new Proxy(value, {
        apply(_, thisArg, args) {
          const calledWithProxy = thisArg === receiver;
          return Reflect.apply(value, calledWithProxy ? target : thisArg, args);
        },
      });
    },
    has(target, prop) {
      if (exclude.has(prop)) target = local;
      return Reflect.has(target, prop);
    },
  });

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/**
 * Python writes stdout one byte at a time, so a line is only text once every
 * byte of it has arrived: decoding byte by byte would split characters.
 */
const pendingLine = () => {
  const bytes: number[] = [];
  return {
    push: (byte: number) => bytes.push(byte),
    take: () => {
      const text = decoder.decode(Uint8Array.from(bytes));
      bytes.length = 0;
      return text;
    },
    peek: () => decoder.decode(Uint8Array.from(bytes)),
  };
};

const io = (
  manager: Kernel,
): {
  [k in "stdin" | "stdout" | "stderr"]: Parameters<
    PyodideAPI[`set${Capitalize<k>}`]
  >[0];
} => {
  const line = pendingLine();

  let input = new Uint8Array();
  let inputIndex = -1; // -1 means that we just returned null
  const stdin = () => {
    if (inputIndex === -1) {
      const text = manager.input(line.peek());
      input = encoder.encode(text + (text.endsWith("\n") ? "" : "\n"));
      inputIndex = 0;
    }

    if (inputIndex < input.length) {
      let character = input[inputIndex];
      inputIndex++;
      return character;
    } else {
      inputIndex = -1;
      return null;
    }
  };

  const raw = (charCode: number) => {
    if (charCode === Char.NewLine)
      manager.output(make("stream", "out", line.take()));
    else line.push(charCode);
  };

  const batched = (output: string) =>
    manager.output(make("stream", "err", output));

  return { stdin: { stdin }, stdout: { raw }, stderr: { batched } };
};

/** Where Pyodide's own runtime files are served from. */
export const defaultIndexURL = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;

export class PyodideInstance {
  readonly globalThisId: string;
  readonly interruptBuffer: Uint8Array<ArrayBufferLike>;
  readonly indexURL: string;

  proxiedGlobalThis: undefined | any;

  pyodide?: PyodideAPI;
  root?: string;

  constructor(options: {
    globalThisId: string;
    interruptBuffer: Uint8Array<ArrayBufferLike>;
    indexURL?: string;
  }) {
    this.globalThisId = options.globalThisId;
    this.interruptBuffer = options.interruptBuffer;
    this.indexURL = options.indexURL ?? defaultIndexURL;
  }

  async init(manager: Kernel, root: string): Promise<any> {
    this.root = root;
    this.proxiedGlobalThis = this.proxyGlobalThis(manager, this.globalThisId);

    this.pyodide = await loadPyodide({
      indexURL: this.indexURL,
      fullStdLib: false,
    });

    const { stdin, stdout, stderr } = io(manager);

    this.pyodide.setStdin(stdin);
    this.pyodide.setStdout(stdout);
    this.pyodide.setStderr(stderr);

    await this.tryPatchMatplotlib(manager);

    this.pyodide.setInterruptBuffer(this.interruptBuffer);

    try {
      this.pyodide.FS.mkdirTree(root);
    } catch (e) {
      console.error("Error creating mount directory in FS", e, root);
    }

    this.pyodide.FS.mount(new EMFS(this.pyodide, manager.syncFs), {}, root);
    this.pyodide.registerJsModule("js", this.proxiedGlobalThis);
  }

  /**
   * Plotting is an extra: a kernel whose page cannot fetch matplotlib still has
   * to finish starting, or every later call would wait on it forever.
   */
  private async tryPatchMatplotlib(manager: Kernel) {
    try {
      await patchMatplotlib(this.pyodide!, (payload) =>
        manager.output(make("display_data", "image", payload)),
      );
    } catch (error) {
      console.warn("Matplotlib is unavailable in this kernel", error);
    }
  }

  async unloadLocalModules() {
    console.log(
      "Unloaded modules:",
      await unloadLocalModules(this.pyodide!, this.root!),
    );
  }

  async addAncestryToSysPath(path: string, recursive = true) {
    let dir = dirname(path);
    while (dir !== this.root) {
      await addToSysPath(this.pyodide!, dir);
      if (!recursive) return;
      dir = dirname(dir);
    }
    await addToSysPath(this.pyodide!, this.root!);
  }

  /**
   * Interrupts are checked between bytecodes, which would cut package loading
   * off half way, so they are off while it happens — and back on afterwards,
   * or the run that follows could never be interrupted either.
   */
  private async whileUninterruptible<T>(work: () => Promise<T>) {
    this.pyodide!.setInterruptBuffer(undefined as any);
    try {
      return await work();
    } finally {
      this.pyodide!.setInterruptBuffer(this.interruptBuffer);
    }
  }

  async load(code: string, filename: string): Promise<void> {
    if (!this.pyodide)
      return console.warn("Worker has not yet been initialized");

    await this.whileUninterruptible(async () => {
      const { loadedPackages, messageCallback } =
        loadMsgFilterAndCollectPackages();
      await this.pyodide!.loadPackagesFromImports(code, { messageCallback });
      await tryResolveProblematicDependencies(this.pyodide!, loadedPackages);
      const { discoveredDirs } = await tryLoadImportsOfLocallyImportedModules(
        this.pyodide!,
        code,
        filename,
      );
      for (const dir of discoveredDirs)
        await this.addAncestryToSysPath(dir, false);
      await this.addAncestryToSysPath(filename, false);
    });
  }

  async run(
    code: string,
    filename: string,
  ): Promise<Output.Specific | undefined | void> {
    if (!this.pyodide)
      return console.warn("Worker has not yet been initialized");

    await this.addAncestryToSysPath(filename);

    let result = await this.pyodide
      .runPythonAsync(code, { filename })
      .catch((error) => error);

    if (result === undefined || result === null) return;
    else if (result instanceof this.pyodide.ffi.PyProxy) {
      if (result._repr_html_ !== undefined) {
        const html = result._repr_html_();
        this.destroyToJsResult(result);
        return make("execute_result", "html", html);
      } else if (result._repr_latex_ !== undefined) {
        const latex = result._repr_latex_();
        this.destroyToJsResult(result);
        return make("execute_result", "latex", latex);
      } else {
        const image = asImage(result);
        if (image) return make("display_data", "image", image);
        else {
          const str = result.__str__();
          this.destroyToJsResult(result);
          return make("execute_result", "plain", str);
        }
      }
    } else if (result instanceof this.pyodide.ffi.PythonError) {
      const { message, type } = result;
      const ename = type;
      const evalue = message.split(`${type}: `)[1]?.trim() ?? "";
      const lines = message.split("\n");
      const firstFileLine = lines.findIndex((line) => line.includes(filename))!;
      const traceback = lines.slice(firstFileLine);
      traceback.splice(0, 0, lines[0]); // Add the error type/message at the start
      return make("error", { ename, evalue, traceback });
    } else return make("execute_result", "plain", String(result));
  }

  private proxyGlobalThis(manager: Kernel, id?: string) {
    // Special cases for the globalThis object. We don't need to proxy everything
    const noProxy = new Set<string | symbol>([
      "location",
      // Proxy navigator, however, some navigator properties do not have to be proxied
      // "navigator",
      "self",
      "importScripts",
      "addEventListener",
      "removeEventListener",
      "caches",
      "crypto",
      "indexedDB",
      "isSecureContext",
      "origin",
      "performance",
      "atob",
      "btoa",
      "clearInterval",
      "clearTimeout",
      "createImageBitmap",
      "fetch",
      "queueMicrotask",
      "setInterval",
      "setTimeout",
      "XMLHttpRequest",

      // networking
      "URL",
      "URLSearchParams",
      "Headers",
      "Request",
      "Response",
      "AbortController",
      "AbortSignal",
      "TextEncoder",
      "TextDecoder",

      // builtins
      "Object",
      "Array",
      "JSON",

      // Special cases for the pyodide globalThis
      "$$",
      "pyodide",
      "__name__",
      "__package__",
      "__path__",
      "__loader__",

      // Pyodide likes checking for lots of properties, like the .stack property to check if something is an error
      // https://github.com/pyodide/pyodide/blob/c8436c33a7fbee13e1ded97c0bbdaa7d635f2745/src/core/jsproxy.c#L1631
      "stack",
      "get",
      "set",
      "has",
      "size",
      "length",
      "then",
      "includes",
      "next",
      Symbol.iterator,
    ]);

    return manager.proxy && id
      ? wrapExcluder(manager.proxy.getObjectProxy(id), globalThis, noProxy)
      : globalThis;
  }

  private destroyToJsResult<T>(x: T): T {
    if (!this.pyodide || !x) return x;
    if (x instanceof this.pyodide.ffi.PyProxy) x.destroy();
    return x;
  }
}
