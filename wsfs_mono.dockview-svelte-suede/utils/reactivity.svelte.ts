import type { IView, PanelUpdateEvent } from "dockview";
import type { AddedPanelByView } from "./index.js";
import type { RecordLike } from "./types.js";

/**
 * Where a reactive value sits within a panel's params: how to write the next
 * value back where the token was found, and what to hand the panel afterwards.
 */
export type ParamSlot = {
  write: (value: unknown) => void;
  changed: () => PanelUpdateEvent;
};

export default class ReactivePanelUpdater<T> {
  get value() {
    return this.current;
  }

  private current?: T;
  private readonly effect: () => void;
  private readonly subscribers: SubscriberMap<T> = new Map();
  private cleanup?: () => void;

  constructor(getter: () => T) {
    this.current = getter();
    this.effect = () => {
      const current = getter();
      this.current = current;
      this.subscribers.forEach((subscriber) => subscriber(current));
    };
  }

  attach(panel: AddedPanelByView, slot: ParamSlot) {
    this.subscribers.set(panel, (value: T) => {
      slot.write(value);
      panel.update(slot.changed() as any);
    });

    this.track(panel);
    this.cleanup ??= $effect.root(() => {
      $effect(this.effect);
    });
  }

  detach(panel: AddedPanelByView) {
    this.subscribers.delete(panel);
    if (this.subscribers.size > 0) return;
    this.cleanup?.();
    this.cleanup = undefined;
  }

  private track(panel: AddedPanelByView) {
    const { ByPanel } = ReactivePanelUpdater;
    const attached = ByPanel.get(panel);
    if (attached) attached.add(this);
    else ByPanel.set(panel, new Set([this]));
  }

  static Detach = (panel: AddedPanelByView | IView) =>
    ReactivePanelUpdater.ByPanel.get(panel as AddedPanelByView)?.forEach(
      (reactive) => reactive.detach(panel as AddedPanelByView)
    );

  /** Weak, so a panel that has been closed is not held alive by this registry. */
  private static readonly ByPanel: PanelMap = new WeakMap();
}

type SubscriberMap<T> = Map<AddedPanelByView, (value: T) => void>;
type PanelMap = WeakMap<AddedPanelByView, Set<ReactivePanelUpdater<any>>>;

export type ClaimedReactive = {
  reactive: ReactivePanelUpdater<any>;
  slot: ParamSlot;
};

/** Only what a panel's params are allowed to be is worth walking into. */
const isWalkable = (value: unknown): value is RecordLike => {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === Array.prototype;
};

const copy = (value: unknown) =>
  Array.isArray(value) ? [...value] : { ...(value as RecordLike) };

/**
 * Swap every reactive token in `params` for the value it currently holds, and
 * pair each with the slot it was found in so it can keep writing there.
 *
 * A token nested inside a param re-sends a *copy* of that param rather than
 * the object it just wrote into: dockview merges params one level deep, and
 * both dockview and Svelte take a value they already hold to mean no change.
 */
export const claimReactives = (params: RecordLike): ClaimedReactive[] => {
  if (params instanceof ReactivePanelUpdater)
    throw new Error(
      "`reactive()` wraps a single param value, not the whole params object"
    );

  const claimed: ClaimedReactive[] = [];
  const walked = new WeakSet<object>();

  const resend = (key: string) => () => ({ params: { [key]: params[key] } });

  const resendCopy = (key: string) => () => ({
    params: { [key]: copy(params[key]) },
  });

  const claim = (container: RecordLike, key: string, topLevel: string) => {
    const value = container[key];

    if (value instanceof ReactivePanelUpdater) {
      container[key] = value.value;
      claimed.push({
        reactive: value,
        slot: {
          write: (next) => (container[key] = next),
          changed:
            container === params ? resend(key) : resendCopy(topLevel),
        },
      });
      return;
    }

    if (!isWalkable(value) || walked.has(value)) return;
    walked.add(value);
    for (const nested in value) claim(value, nested, topLevel);
  };

  for (const key in params) claim(params, key, key);

  return claimed;
};
