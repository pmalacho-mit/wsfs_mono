/// <reference types="vite/client" />

import KernelWorker from "./worker/kernel-worker?worker";
import { HostBridge } from "./worker/bridge";
import type { Patience } from "./worker/channel";
import type { Kernel } from "./worker/kernel-worker";
import { contents, type Contents } from "./contents";
import { base64, flatPromise, type Awaitable, type Expand } from "./utils";
import { type Output, make } from "./output";
import fs, { type HostFileSystem } from "./fs";

export type Environment = {
  /**
   * Filesystem the Python worker reads and writes through, including its mount
   * root. Every method may answer with a promise.
   */
  fs: HostFileSystem & {
    /**
     * The root path that the filesystem is mounted at in the Python environment.
     */
    root: string;
  };
  /** Prompt handler used when Python requests user input. */
  input: (prompt: string) => Awaitable<string>;
  /**
   * Where Pyodide's own runtime files are served from. Defaults to the CDN copy
   * matching the pinned Pyodide version; point it at a same-origin directory to
   * run without reaching the network.
   */
  indexURL?: string;
  /**
   * How long Python waits on the page before giving up on it.
   *
   * The default allows five minutes, which is generous for a filesystem and
   * short for a prompt a person has to answer. Raise it if the page can
   * legitimately take longer; there is no way to tell a slow answer from one
   * that is never coming, so this is the only thing that distinguishes them.
   */
  patience?: Patience;
};

export namespace Run {
  type Callback<T extends any[] = []> = (...args: T) => any;

  export type Events = {
    start: [];
    complete: [outputs: Output.Specific[]];
    output: [output: Output.Specific];
  };

  export type On = Partial<{
    [K in keyof Events]: Callback<Events[K]>;
  }>;

  export type Job = Expand<{
    interrupt: () => void;
    result: Promise<Output.Specific[]>;
  }>;
}

/** Resolve a path relative to the configured filesystem root. */
const fromRoot = ({ fs: { root } }: Environment, path: string) =>
  root.endsWith("/")
    ? root + path.replace(/^\/+/, "")
    : root + "/" + path.replace(/^\/+/, "");

/** Default filename used when code is executed without an explicit path. */
const defaultPath = (env: Environment) => fromRoot(env, "temp.py");

/** Attach worker message handling for bridge traffic and kernel lifecycle events. */
const handleMessages = ({ worker, bridge, callbacks }: PythonKernel) =>
  worker.addEventListener("message", (ev: MessageEvent) => {
    if (!ev.data) {
      console.warn("Unexpected message from kernel manager", ev);
      return;
    }
    const data = ev.data as Kernel.Response;

    if (bridge.handle(data)) return;
    if (data.type === "output") callbacks.output?.(data);
    else if (data.type === "finished" || data.type === "loaded")
      callbacks[data.type]?.();
  });

export default class PythonKernel {
  readonly worker = new KernelWorker();
  readonly bridge: HostBridge;
  readonly environment: Environment;

  readonly callbacks = {
    loaded: undefined as (() => void) | undefined,
    output: undefined as ((output: Output.Specific) => void) | undefined,
    finished: undefined as (() => void) | undefined,
  };

  readonly ready: Promise<void>;

  private operationChain = Promise.resolve();

  /**
   * Reserve a turn in the serialized operation queue and return both the
   * previous operation and the completion handle for this operation.
   */
  private queueOperation() {
    const done = flatPromise<void>();
    const previous = this.operationChain.catch((_) => 0);
    this.operationChain = done.promise;
    return { previous, done };
  }

  /** Wait for a one-shot worker lifecycle signal. */
  private signal(signal: "loaded" | "finished") {
    return new Promise<void>((resolve) => (this.callbacks[signal] = resolve));
  }

  /** Post a typed kernel request to the worker. */
  private post<T extends keyof Kernel.Requests>(request: Kernel.Request<T>) {
    this.worker.postMessage(request);
  }

  /** Create a kernel instance and initialize worker wiring. */
  constructor(environment: Environment) {
    this.environment = environment;
    const { fs, input } = environment;

    this.bridge = new HostBridge({ fs, input: { prompt: input } });
    handleMessages(this);
    const { worker, bridge } = this;

    const payload: Kernel.Request = {
      type: "initialize",
      root: fs.root,
      buffers: bridge.buffers,
      globalThisId: bridge.objects.registerRootObject(globalThis),
      indexURL: environment.indexURL,
      patience: environment.patience,
    };

    this.ready = new Promise((resolve) => {
      const onInitialized = (ev: MessageEvent) => {
        if (!ev.data) return;
        const data = ev.data as Kernel.Response;
        if (data.type === "initialized") {
          worker.removeEventListener("message", onInitialized);
          resolve();
        }
      };
      worker.addEventListener("message", onInitialized);
      this.post(payload);
    });
  }

  /** Interrupt the currently executing Python code, if any. */
  interrupt() {
    this.bridge.memory.interrupt();
  }

  /** Clear the interrupt flag before a new operation starts. */
  clearInterrupt() {
    this.bridge.memory.clearInterrupt();
  }

  /**
   * Optimistically preload Python package dependencies for the provided code.
   *
   * This only resolves imports; it does not execute the code body.
   */
  load(code: string, filename?: string): Promise<void> {
    const { previous, done } = this.queueOperation();
    return new Promise<void>(async (resolve) => {
      try {
        await this.ready;
        await previous;
        const loaded = this.signal("loaded");
        const file = filename ?? defaultPath(this.environment);
        this.post({ type: "load", code, file });
        await loaded;
      } finally {
        done.resolve();
        resolve();
      }
    });
  }

  /**
   * Execute Python code, optionally with lifecycle and output callbacks.
   */
  run(code: string, on?: Run.On): Run.Job;
  /**
   * Execute Python code with optional path override and module unload behavior.
   */
  run(request: {
    code: string;
    path?: string;
    on?: Run.On;
    /**
     * Whether to unload local modules before executing the code.
     *
     * This can allow using the kernel to execute local files in a 'fresh' state without having to restart the kernel and/or reload external modules.
     *
     * In this way, the kernel can be used more like a traditional Python execution environment, where executing a file will re-import it and reflect changes to it and its dependencies
     * (while still maintaining the performance benefits of using an already initialized Pyodide instance and preserving already loaded external modules).
     */
    unloadLocalModules?: boolean;
  }): Run.Job;
  /** Run request implementation shared by both overload signatures. */
  run(
    arg:
      | string
      | {
          code: string;
          path?: string;
          on?: Run.On;
          unloadLocalModules?: boolean;
        },
    on?: Run.On,
  ): Run.Job {
    const code = typeof arg === "string" ? arg : arg.code;
    on ??= typeof arg !== "string" ? arg.on : undefined;

    const path =
      typeof arg === "string"
        ? defaultPath(this.environment)
        : (fromRoot(this.environment, arg.path ?? "temp.py") ??
          defaultPath(this.environment));

    const { previous, done } = this.queueOperation();

    let executing = false;
    let doExecute = true;

    /**
     * Once the worker has been asked to run, only the interrupt buffer can stop
     * it — and the queue stays held until it reports back, so the next run
     * cannot overlap this one.
     */
    const interrupt = () => {
      if (executing) this.interrupt();
      else doExecute = false;
    };

    const result = new Promise<Output.Specific[]>(async (resolve) => {
      const outputs = new Array<Output.Specific>();
      try {
        await this.ready;
        await previous;

        if (!doExecute) return resolve(outputs);

        this.callbacks.output = (output) => {
          outputs.push(output);
          on?.output?.(output);
        };

        this.clearInterrupt();
        on?.start?.();

        const loaded = this.signal("loaded");
        const finished = this.signal("finished");

        executing = true;
        this.post({
          type: "run",
          code,
          file: path,
          unloadLocalModules:
            typeof arg === "string" ? false : arg.unloadLocalModules,
        } satisfies Kernel.Request<"run">);

        await loaded;
        await finished;
      } catch (e: any) {
        this.callbacks.output?.(
          make("error", {
            ename: e.name,
            evalue: e.message,
            traceback: e.stack ? e.stack.split("\n") : [],
          }),
        );
      } finally {
        executing = false;
        done.resolve();
        on?.complete?.(outputs);
        resolve(outputs);
      }
    });

    return { interrupt, result };
  }

  /** Terminate worker resources and shared memory handles. */
  dispose() {
    this.worker.terminate();
    this.bridge.dispose();
  }

  /** Build a `data:` URL for contents already in hand. */
  assetURL(request: { value: Contents; path: string }): string | null;
  assetURL(request: { value: Contents; mimeType: string }): string | null;
  /** Read the file out of the environment's filesystem, then build its URL. */
  assetURL(request: { path: string }): Promise<string | null>;
  assetURL(
    request:
      | { path: string }
      | ({ value: Contents } & ({ path: string } | { mimeType: string })),
  ) {
    if ("value" in request) return PythonKernel.AssetUrl(request);
    return this.readAssetURL(request.path);
  }

  private async readAssetURL(path: string) {
    const result = await this.environment.fs.get({ path });
    if (!result.ok || result.data === null) {
      console.warn(`Asset at path "${path}" not found or is a directory`);
      return null;
    }
    return PythonKernel.AssetUrl({ value: result.data, path });
  }

  static readonly DefaultFileSystemRoot = fs.defaultRoot;

  /** Default prompt implementation used by the kernel environment. */
  static readonly DefaultInput = (prompt: string) =>
    window.prompt(prompt) ?? "";

  /**
   * In-memory filesystem adapter that returns not-found for reads and no-ops
   * for writes.
   */
  static readonly EmptyFileSystem = fs.empty;

  /**
   * Create a read-only filesystem facade layered on top of an optional base
   * filesystem implementation.
   */
  static readonly ReadOnlyFileSystem = fs.readOnly;

  /**
   * Create a write-only filesystem facade layered on top of an optional base
   * filesystem implementation.
   */
  static readonly WriteOnlyFileSystem = fs.writeOnly;

  /** Create a read-write filesystem facade by composing read-only and write-only adapters. */
  static readonly ReadWriteFileSystem = fs.readWrite;

  static AssetUrl({
    value,
    ...rest
  }: {
    value: Contents;
  } & ({ path: string } | { mimeType: string })) {
    if (value === null || value === undefined) return null;
    if (contents.isText(value) && value.startsWith("data:")) return value;
    const mimeType =
      "mimeType" in rest ? rest.mimeType : fs.inferMimeType(rest.path);
    return `data:${mimeType};base64,${base64.encode(value)}`;
  }

  /** Build an environment with default filesystem and input handlers. */
  static readonly Environment = ({
    fs = PythonKernel.EmptyFileSystem(),
    input = PythonKernel.DefaultInput,
    ...rest
  }: Partial<Environment> = {}): Environment => ({ input, fs, ...rest });

  /** Construct a kernel with the default environment configuration. */
  static readonly Default = () => new PythonKernel(PythonKernel.Environment());
}
