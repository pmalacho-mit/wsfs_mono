import type {
  FileTreeAddEvent,
  FileTreeBatchEvent,
  FileTreeDropContext,
  FileTreeDropResult,
  FileTreeMoveEvent,
  FileTreeMutationEvent,
  FileTreeRemoveEvent,
  FileTreeRenameEvent,
  FileTreeResetEvent,
} from "@pierre/trees";

export type Unsubscribe = () => void;

export type Events = {
  added: [event: FileTreeAddEvent];
  removed: [event: FileTreeRemoveEvent];
  moved: [event: FileTreeMoveEvent];
  reset: [event: FileTreeResetEvent];
  batched: [event: FileTreeBatchEvent];
  mutated: [event: FileTreeMutationEvent];
  "selection changed": [paths: readonly string[]];
  "focus changed": [path: string | null];
  "search changed": [value: string | null];
  renamed: [event: FileTreeRenameEvent];
  "rename refused": [error: string];
  dropped: [event: FileTreeDropResult];
  "drop refused": [error: string, context: FileTreeDropContext];
};

export type Handlers = {
  [Name in keyof Events]?: (...args: Events[Name]) => void;
};

/** Storing handlers by name erases their argument types; the two public methods restore them. */
type ErasedHandler = (...args: any[]) => void;

export class Emitter {
  readonly #byName = new Map<keyof Events, Set<ErasedHandler>>();

  subscribe(handlers: Handlers): Unsubscribe {
    const removals = Object.entries(handlers)
      .filter(([, handler]) => handler !== undefined)
      .map(([name, handler]) => this.#add(name as keyof Events, handler));
    return () => {
      for (const remove of removals) remove();
    };
  }

  emit<Name extends keyof Events>(name: Name, ...args: Events[Name]): void {
    const handlers = this.#byName.get(name);
    if (handlers === undefined) return;
    for (const handler of [...handlers]) handler(...args);
  }

  #add(name: keyof Events, handler: ErasedHandler): Unsubscribe {
    const handlers = this.#byName.get(name) ?? new Set<ErasedHandler>();
    this.#byName.set(name, handlers);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }
}

export const announceMutation = (
  emitter: Emitter,
  event: FileTreeMutationEvent,
): void => {
  emitter.emit("mutated", event);
  switch (event.operation) {
    case "add":
      return emitter.emit("added", event);
    case "remove":
      return emitter.emit("removed", event);
    case "move":
      return emitter.emit("moved", event);
    case "reset":
      return emitter.emit("reset", event);
    case "batch":
      return emitter.emit("batched", event);
  }
};
