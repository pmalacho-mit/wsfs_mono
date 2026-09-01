import type { AsyncMemory } from "./async-memory";
import {
  answering,
  fileSystemMethods,
  type SyncFileSystem,
} from "./emscripten-fs";
import { WorkerBridge, type BridgeMessages } from "./bridge";
import type { Patience } from "./channel";
import { ObjectId, type ObjectProxyClient } from "./object-proxy";
import { PyodideInstance } from "../pyodide/instance";
import type { Typed } from "../utils";
import { make, type Output } from "../output";

export namespace Kernel {
  type Source = {
    code: string;
    /**
     * The filename to associate with this code execution
     *
     * Relative paths will be resolved against the kernel's workspace root.
     *
     * @example /home/pyodide/main.py
     */
    file: string;
  };
  export type Requests = {
    initialize: {
      buffers: AsyncMemory.Buffers;
      globalThisId: string;
      /** Where Pyodide's runtime files are served from. */
      indexURL?: string;
      /** How long the worker waits on the host before giving up. */
      patience?: Patience;
      /**
       * The workspace root path for this kernel
       * (assumed to be where all executed files are located)
       * @example /home/pyodide
       */
      root: string;
    };
    run: Source & {
      unloadLocalModules?: boolean;
    };
    load: Source;
  };

  export type Responses = {
    initialized: {};
    kernel_initialized: {
      kernelId: string;
    };
    loaded: {};
    output: Output.Specific;
    finished: {};
  } & BridgeMessages;

  export type Request<T extends keyof Requests = keyof Requests> =
    Typed<Requests> & { type: T };
  export type Response<T extends keyof Responses = keyof Responses> =
    Typed<Responses> & { type: T };

  export type RequestHandler = {
    [k in keyof Requests as `on${Capitalize<k>}`]: (
      manager: Kernel,
      data: Requests[k],
    ) => any;
  };
}

const handler = {
  onInitialize: async (manager, data) => {
    const bridge = new WorkerBridge(
      data.buffers,
      (message) => manager.postMessage(message),
      data.patience,
    );

    manager.proxy = bridge.objects;
    manager.input = (prompt) => bridge.calls.call("input", "prompt", prompt);
    manager.syncFs = answering(
      bridge.calls.facade<SyncFileSystem>("fs", [...fileSystemMethods]),
    );
    manager.pyodide = new PyodideInstance({
      globalThisId: data.globalThisId,
      interruptBuffer: bridge.memory.interrupter,
      indexURL: data.indexURL,
    });

    await manager.pyodide.init(manager, data.root);
    manager.postMessage({ type: "initialized" });
  },
  onRun: async (manager, { code, file, unloadLocalModules }) => {
    let loaded = false;
    try {
      await manager.pyodide.load(code, file);
      if (unloadLocalModules) await manager.pyodide.unloadLocalModules();
      loaded = true;
      manager.postMessage({ type: "loaded" });
      const value = await manager.pyodide.run(code, file);
      if (value) manager.output(value);
    } catch (e) {
      manager.output(
        make("error", {
          ename: "ExecutionError",
          evalue: (e as Error).message,
          traceback: (e as Error).stack ? (e as Error).stack!.split("\n") : [],
        }),
      );
    } finally {
      if (!loaded) manager.postMessage({ type: "loaded" });
      manager.postMessage({ type: "finished" });
    }
  },
  onLoad: async (manager, { code, file }) => {
    try {
      await manager.pyodide.load(code, file);
    } catch (e) {
      manager.output(
        make("error", {
          ename: "LoadError",
          evalue: (e as Error).message,
          traceback: (e as Error).stack ? (e as Error).stack!.split("\n") : [],
        }),
      );
    } finally {
      manager.postMessage({ type: "loaded" });
    }
  },
} satisfies Kernel.RequestHandler;

const handle = (manager: Kernel, msg: Kernel.Request) => {
  const { type } = msg;
  const methodName =
    `on${type.charAt(0).toUpperCase()}${type.slice(1)}` as keyof Kernel.RequestHandler;
  if (!(methodName in handler))
    throw new Error(`No handler for message type ${type}`);
  handler[methodName](manager, msg as any);
};

/**
 * Manages all the kernels in this worker.
 */
export class Kernel {
  /** BEGIN: Properties set by the initialize message */
  proxy!: ObjectProxyClient;
  input!: (prompt: string) => string;
  syncFs!: SyncFileSystem;
  pyodide!: PyodideInstance;
  /** END: Properties set by the initialize message */

  constructor() {
    const _handle = handle.bind(null, this);
    self.addEventListener("message", async (e: MessageEvent) => {
      if (!e.data) console.warn("Unexpected kernel worker  message:", e);
      else _handle(e.data);
    });
  }

  output(output: Output.Specific) {
    const casted = output satisfies Omit<
      Kernel.Response<"output">,
      "type"
    > as Kernel.Response<"output">;
    casted.type = "output";
    this.postMessage(casted);
  }

  postMessage(message: Kernel.Response) {
    self.postMessage(message);
  }

  [ObjectId] = "";
}

const singleton = new Kernel();
export default singleton;
