import { nanoid } from "nanoid";
import type { ChannelHost, ChannelWorker } from "./channel";
import { codec, type References } from "./codec";
import { settled, type Settled } from "./settled";
import type { Typed } from "../utils";

export const ObjectId = Symbol.for("id");

/**
 * Whether an id stands for a function is part of the id, because a proxy has to
 * decide what to wrap before it can ask the other thread anything about it.
 */
const FUNCTION_KIND = "f";

const kindOf = (value: unknown) =>
  typeof value === "function" ? FUNCTION_KIND : "o";

/** The id an object carries when it lives on the other thread. */
const idOf = (value: any): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const id = value[ObjectId];
  return typeof id === "string" ? id : undefined;
};

const isThenable = (value: any): value is PromiseLike<unknown> =>
  typeof value?.then === "function";

const labelOfInstance = (value: any): string | undefined => {
  if (value === globalThis) return "globalThis";
  if (Array.isArray(value)) return "Array";
  const constructor = value?.constructor?.name;
  return constructor && constructor !== "Object" ? constructor : undefined;
};

const labelOfShape = (value: any) => {
  const keys = Object.keys(value);
  return keys.length > 0 ? `{${keys.slice(0, 3).join(",")}}` : "obj";
};

/** A human readable hint baked into ids so proxy traffic can be debugged. */
const label = (value: any): string => {
  try {
    if (typeof value === "function") return value.name || "anon";
    return labelOfInstance(value) ?? labelOfShape(value);
  } catch {
    return "unknown";
  }
};

/**
 * Lets one other thread access the objects on this thread.
 * Usually runs on the main thread.
 */
export class ObjectProxyHost {
  readonly rootReferences = new Map<string, any>();
  readonly temporaryReferences = new Map<string, any>();

  /**
   * The id an object was already given. Without it every crossing would mint a
   * new one, so the same object would arrive as a different object each time
   * and the registry would grow for as long as the kernel lived.
   */
  private readonly identifiers = new WeakMap<object, string>();

  readonly references: References = {
    encode: (value) => this.registerTempObject(value),
    decode: (id) => this.getObject(id),
  };

  constructor(private readonly channel: ChannelHost) {}

  private getId(value: any) {
    return `${kindOf(value)}:${nanoid()}-${label(value)}`;
  }

  registerRootObject(value: any) {
    const id = this.getId(value);
    this.rootReferences.set(id, value);
    this.identifiers.set(value, id);
    return id;
  }

  registerTempObject(value: any) {
    const known = this.identifiers.get(value);
    if (known !== undefined) return known;

    const id = this.getId(value);
    this.temporaryReferences.set(id, value);
    this.identifiers.set(value, id);
    return id;
  }

  /** Called when the worker has collected the proxy that stood for this id. */
  releaseTempObject(id: string) {
    const value = this.temporaryReferences.get(id);
    if (value === undefined) return;
    this.temporaryReferences.delete(id);
    this.identifiers.delete(value);
  }

  getObject(id: string) {
    return this.rootReferences.get(id) ?? this.temporaryReferences.get(id);
  }

  respond(result: Settled, request: number) {
    this.channel.send(this.encode(result), request);
  }

  /** A result that cannot be encoded still has to reach the blocked worker. */
  private encode(result: Settled) {
    try {
      return codec.encode(result, this.references);
    } catch (thrown) {
      return codec.encode(settled.failure(thrown));
    }
  }

  handleProxyMessage(message: ProxyMessage, request: number) {
    if (message.type === "proxy_reflect")
      this.respond(
        settled.capture(() => this.reflect(message)),
        request,
      );
    else if (message.type === "proxy_promise")
      this.settlePromise(message, request);
    else if (message.type === "proxy_release")
      this.releaseTempObject(message.target);
    else console.warn("Unknown proxy message", message);
  }

  private reflect(message: ProxyMessages["proxy_reflect"] & { type: string }) {
    const target = this.getObject(message.target);
    const args = codec.decode(message.args, this.references) as any[];
    if (message.method === "apply")
      return Reflect.apply(target, this.getObject(message.thisArg!), args);
    return (Reflect[message.method] as any)(target, ...args);
  }

  private settlePromise(
    { target }: ProxyMessages["proxy_promise"],
    request: number,
  ) {
    const value = this.getObject(target);
    if (!isThenable(value)) return this.respond({ ok: true, value }, request);
    value.then(
      (value) => this.respond({ ok: true, value }, request),
      (error) => this.respond(settled.failure(error), request),
    );
  }
}

/**
 * Allows this thread to access objects from another thread.
 * Must run on a worker thread.
 */
export class ObjectProxyClient {
  readonly references: References = {
    identify: (value) => idOf(value),
    encode: (value) => this.referenceTo(value),
    decode: (id) => this.getObjectProxy(id),
  };

  /** One proxy per id, so `===` means the same thing on both threads. */
  private readonly proxies = new Map<string, WeakRef<any>>();

  /** Tells the host an id is finished with once nothing here refers to it. */
  private readonly collected = new FinalizationRegistry<string>((id) => {
    this.proxies.delete(id);
    this.postMessage({ type: "proxy_release", target: id });
  });

  constructor(
    private readonly channel: ChannelWorker,
    private readonly postMessage: (message: ProxyMessage) => void,
  ) {}

  private referenceTo(value: object | Function) {
    const id = idOf(value);
    if (id === undefined)
      throw new Error("Cannot send a worker-owned object to the host");
    return id;
  }

  private request(message: ProxyMessage): any {
    const payload = this.channel.request(() => this.postMessage(message));
    return settled.unwrap(codec.decode(payload, this.references) as Settled);
  }

  /**
   * Calls a Reflect function on an object from the other thread
   * @returns The result of the operation, can be a primitive or a proxy
   */
  private proxyReflect(
    method: keyof typeof Reflect,
    target: string,
    args: any[],
  ) {
    const message: ProxyMessage =
      method === "apply"
        ? {
            type: "proxy_reflect",
            method,
            target,
            thisArg: args[0],
            args: this.encodeArguments(args[1]),
          }
        : {
            type: "proxy_reflect",
            method,
            target,
            args: this.encodeArguments(args),
          };

    return this.request(message);
  }

  private encodeArguments(args: any[]) {
    return codec.encode(args, this.references);
  }

  private isFunction(id: string) {
    return id.startsWith(`${FUNCTION_KIND}:`);
  }

  /**
   * Gets a proxy object for a given id
   */
  getObjectProxy<T = any>(id: string): T {
    const existing = this.proxies.get(id)?.deref();
    if (existing !== undefined) return existing as T;

    const created = this.createProxy(id);
    this.proxies.set(id, new WeakRef(created));
    this.collected.register(created, id);
    return created as T;
  }

  private createProxy(id: string) {
    const client = this;

    return new Proxy(this.isFunction(id) ? function () {} : {}, {
      get(target, prop, receiver) {
        if (prop === ObjectId) return id;

        const value = client.proxyReflect("get", id, [prop, receiver]);
        if (typeof value !== "function") return value;

        /* Functions need special handling
         * https://stackoverflow.com/questions/27983023/proxy-on-dom-element-gives-error-when-returning-functions-that-implement-interfa
         * https://stackoverflow.com/questions/37092179/javascript-proxy-objects-dont-work
         */
        return new Proxy(value, {
          apply(_, thisArg, argumentsList) {
            const calledWithProxy = thisArg === receiver;
            return client.proxyReflect("apply", idOf(value)!, [
              calledWithProxy ? id : idOf(thisArg),
              argumentsList,
            ]);
          },
        });
      },
      set(target, prop, value, receiver) {
        return client.proxyReflect("set", id, [prop, value, receiver]);
      },
      ownKeys(target) {
        return client.proxyReflect("ownKeys", id, []);
      },
      has(target, prop) {
        return client.proxyReflect("has", id, [prop]);
      },
      defineProperty(target, prop, attributes) {
        return client.proxyReflect("defineProperty", id, [prop, attributes]);
      },
      deleteProperty(target, prop) {
        return client.proxyReflect("deleteProperty", id, [prop]);
      },
      apply(target, thisArg, argumentsList) {
        return client.proxyReflect("apply", id, [idOf(thisArg), argumentsList]);
      },
      /*
       * getOwnPropertyDescriptor, getPrototypeOf and isExtensible are left to
       * the empty local target on purpose: each would cost a blocking round
       * trip on operations that ask for them implicitly. Reflection over a
       * proxy (Object.keys, spread, instanceof) therefore describes the local
       * target, not the object on the other thread.
       */
      construct(target, argumentsList, newTarget) {
        return client.proxyReflect("construct", id, [argumentsList, newTarget]);
      },
    });
  }

  /**
   * Blocks until a proxied promise has returned a result or an error
   */
  thenSync<T>(value: Promise<T>): T {
    const target = idOf(value);
    if (target === undefined) throw new Error("Not a proxy object");
    return this.request({ type: "proxy_promise", method: "then", target });
  }
}

export type ProxyMessages = {
  proxy_reflect: {
    method: keyof typeof Reflect;
    /** An object id */
    target: string;
    /** An object id, only present when the method is "apply" */
    thisArg?: string;
    /** Further parameters, encoded by the codec */
    args: Uint8Array;
  };

  proxy_promise: {
    method: "then";
    target: string;
  };

  proxy_release: {
    /** An object id the worker no longer has a proxy for */
    target: string;
  };
};

export type ProxyMessage = Typed<ProxyMessages>;
