import type { Expand } from "./utils";

type PayloadsConstraint = Record<string | number, any[]>;

export type PayloadsToEvents<T extends PayloadsConstraint, Target> = {
  [k in keyof T]: (...payload: [...T[k], target: Target]) => void;
};

export type PayloadsToCollectionEvents<T extends PayloadsConstraint, Target> = {
  [k in keyof T]: (
    ...payload: [...T[k], target: Target, index: number]
  ) => void;
};

type Unsubscriber = (unsubscribe: () => void) => void;

export class WithEvents<Payloads extends PayloadsConstraint> {
  private readonly listeners = new Map<
    keyof Payloads,
    Set<(...payload: any) => void>
  >();

  /**
   * Subscribes to one or more events.
   * Returns an unsubscribe function for unsubscribing all events, with extra properties for unsubscribing individual event keys.
   * @param callbacks
   * @param unsubscriber - A callback that will be provided with the unsubscribe function for unsubscribing all events.
   * (Useful for things like svelte's `onDestroy` or other methods invoked on cleanup)
   * @returns {Function & Record<string, Function>}
   */
  subscribe<T extends Expand<Partial<PayloadsToEvents<Payloads, typeof this>>>>(
    callbacks: T,
    unsubscriber?: Unsubscriber
  ) {
    const unsubscribers = {} as { [key in keyof T]: () => void };

    type Events = PayloadsToEvents<Payloads, typeof this>;
    for (const key in callbacks)
      unsubscribers[key] = this.subscribeKey(
        key,
        callbacks[key] as Events[keyof Events]
      );

    const unsubscribeAll = () => {
      for (const key in callbacks) unsubscribers[key as keyof T]?.();
    };

    unsubscriber?.(unsubscribeAll);

    return Object.assign(unsubscribeAll, unsubscribers);
  }

  /**
   * Subscribes to one or more events that will be automatically unsubscribed after the first occurrence.
   * Each event callback will only be invoked once, then automatically unsubscribed.
   * @param callbacks - An object mapping event names to callback functions
   * @param unsubscriber - A callback that will be provided with the unsubscribe function for manually unsubscribing all events before they fire
   * @returns An unsubscribe function for unsubscribing all events, with extra properties for unsubscribing individual event keys
   * @example
   * ```ts
   * instance.once({
   *   ready: () => console.log('Ready event fired once')
   * });
   * ```
   */
  once<T extends Expand<Partial<PayloadsToEvents<Payloads, typeof this>>>>(
    callbacks: T,
    unsubscriber?: (unsubscribe: () => void) => void
  ) {
    let unsubscribe: ReturnType<typeof this.subscribe<T>>;
    const wrappedCallbacks = {} as T;
    for (const key in callbacks) {
      const callback = callbacks[key] as (...payload: any[]) => void;
      const wrapped = (...payload: Parameters<typeof callback>) => {
        callback(...payload);
        unsubscribe[key]();
      };
      wrappedCallbacks[key as keyof T] = wrapped as T[keyof T];
    }
    unsubscribe = this.subscribe(wrappedCallbacks, unsubscriber);
    return unsubscribe;
  }

  /**
   * Creates a subscription helper that will automatically unsubscribe when a specific event fires.
   * Useful for subscribing to events that should only be active until a certain condition occurs.
   * @param event - The event name that, when fired, will trigger unsubscription
   * @returns An object with a `subscribe` method that accepts callbacks and auto-unsubscribes when the specified event fires
   * @example
   * ```ts
   * // Subscribe to 'data' events until 'complete' fires
   * instance.until('complete').subscribe({
   *   data: (value) => console.log('Data:', value)
   * });
   * ```
   */
  until<Event extends keyof Payloads>(event: Event) {
    const subscribe = <
      T extends Expand<Partial<PayloadsToEvents<Payloads, typeof this>>>
    >(
      callbacks: T
    ) => {
      const unsubscribe = this.subscribe(callbacks);
      const onEvent = { [event]: unsubscribe };
      return this.once(onEvent as T);
    };
    return { subscribe };
  }

  /**
   * Fires an event, invoking all registered listeners for that event.
   * The event instance is automatically appended as the last argument to each listener.
   * @param event - The name of the event to fire
   * @param payload - The arguments to pass to the event listeners
   * @example
   * ```ts
   * instance.fire('dataChanged', newValue, oldValue);
   * ```
   */
  fire<Event extends keyof Payloads>(
    event: Event,
    ...payload: Payloads[Event]
  ) {
    this.listeners
      .get(event)
      ?.forEach((callback) => callback(...payload, this));
  }

  /**
   * Returns the number of listeners registered for a specific event.
   * @param event - The event name to check
   * @returns The number of active listeners for the event, or 0 if none exist
   */
  listenerCount(event: keyof Payloads) {
    return this.listeners.get(event)?.size ?? 0;
  }

  /**
   * Returns an object containing listener counts for all registered events.
   * Each property is a getter that returns the current count for that event.
   * @returns An object mapping event names to their listener counts
   */
  get listenerCounts() {
    type Counts = Record<keyof Payloads, number>;
    let counts: Partial<Counts> = {};
    for (const [event, listeners] of this.listeners)
      counts = {
        ...counts,
        get [event]() {
          return listeners.size;
        },
      };
    return counts as Counts;
  }

  clear() {
    this.listeners.forEach((set) => set.clear());
    this.listeners.clear();
  }

  /**
   * Creates a collection-level event handler for multiple WithEvents instances.
   * Allows subscribing to events from all instances in the collection, with callbacks receiving the target instance and index.
   * @param withEvents - An array of WithEvents instances to collect
   * @returns An object with `fire` and `subscribe` methods that operate on all instances in the collection
   * @example
   * ```ts
   * const instances = [instance1, instance2, instance3];
   * const collection = WithEvents.Collect(instances);
   *
   * collection.subscribe({
   *   change: (value, target, index) => {
   *     console.log(`Instance ${index} changed:`, value);
   *   }
   * });
   *
   * // Fire event on all instances
   * collection.fire('change', newValue);
   * ```
   */
  static Collect = <const T extends WithEvents<PayloadsConstraint>>(
    withEvents: T[]
  ) => {
    type IndividualPayloads = ExtractPayloads<T>;
    type CollectionEvents = {
      [k in keyof IndividualPayloads]: (
        ...payload: [...IndividualPayloads[k], target: T, index: number]
      ) => void;
    };

    return {
      fire: ((event, ...payload) => {
        for (let index = 0; index < withEvents.length; index++)
          withEvents[index].fire(event, ...payload);
      }) satisfies T["fire"],
      subscribe: <Callbacks extends Expand<Partial<CollectionEvents>>>(
        callbacks: Callbacks,
        unsubscriber?: Unsubscriber
      ) => {
        type CallbackKey = keyof typeof callbacks;

        const keys = Object.keys(callbacks) as CallbackKey[];
        const unsubscribers = keys.reduce((acc, key) => {
          acc[key] = [];
          return acc;
        }, {} as { [key in CallbackKey]: (() => void)[] });

        for (let index = 0; index < withEvents.length; index++) {
          const target = withEvents[index];
          for (const key of keys) {
            const callback = callbacks[key] as (...args: any[]) => void;
            unsubscribers[key].push(
              (target as any as WithEvents<any>).subscribeKey(key, (...args) =>
                callback(...args, index)
              )
            );
          }
        }

        const ubsubscribeKey = (key: CallbackKey) => {
          for (let index = 0; index < unsubscribers[key].length; index++)
            unsubscribers[key][index]();
        };

        const unsubscribeAll = () => {
          for (const key of keys) ubsubscribeKey(key);
        };

        unsubscriber?.(unsubscribeAll);

        return Object.assign(
          unsubscribeAll,
          keys.reduce((acc, key) => {
            acc[key as CallbackKey] = () => ubsubscribeKey(key);
            return acc;
          }, {} as Record<CallbackKey, () => void>)
        );
      },
    };
  };

  private subscribeKey<K extends keyof Payloads>(
    event: K,
    callback: PayloadsToEvents<Payloads, typeof this>[K]
  ) {
    this.listeners.get(event)?.add(callback) ??
      this.listeners.set(event, new Set([callback]));

    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }
}

export type IWithEvents<Payloads extends PayloadsConstraint> = Pick<
  WithEvents<Payloads>,
  keyof WithEvents<Payloads>
>;

export type ExtractPayloads<T> = T extends IWithEvents<PayloadsConstraint>
  ? Parameters<T["fire"]> extends [infer key extends string, ...any[]]
    ? {
        [k in key]: Required<Parameters<T["subscribe"]>[0]>[k] extends (
          ...args: [...infer P, target: T]
        ) => void
          ? P
          : never;
      }
    : never
  : never;
