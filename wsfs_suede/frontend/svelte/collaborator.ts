/**
 * One participant, as a test can drive one.
 *
 * The protocol itself is NOT here any more -- it is in `room.svelte.ts`, which
 * is the same code `Workspace.svelte` runs. That is the point: what these two
 * browsers prove is now a claim about the component a user touches rather than
 * about a second implementation that merely resembled it.
 *
 * What is left here is everything a scenario needs and a widget does not: the
 * identity to connect as, a network that can be taken away and given back, and
 * the snapshot/reconstruction round trip. It is still separate from
 * `Workspace.svelte` on purpose -- the claims are about what happens BETWEEN
 * two clients, and a monaco instance in the middle would only make a failure
 * harder to place.
 */
import { createClient } from "@liveblocks/client";
import { LiveblocksYjsProvider } from "@liveblocks/yjs";
import { IndexeddbPersistence, storeState } from "y-indexeddb";
import { Rooms, type Persist, type Host } from "./room.svelte";
import type { Workspace } from "../";

type LiveblocksClient = ReturnType<typeof createClient>;

/**
 * Asking the host to fill a room now, so opening the file later is instant.
 */
export const warmRoom = async (
  workspace: Pick<Workspace, "room">,
  entry: string,
): Promise<void> => {
  await workspace.room.warm(entry);
};

const synchronized = (provider: LiveblocksYjsProvider) =>
  provider.getStatus() === "synchronized";

/**
 * Settles once Liveblocks has confirmed everything this client is holding.
 *
 * Subscribed rather than polled, and it is the answer `#settling` used to
 * guess at with 600ms. What matters is that the SERVER has the changes, not
 * that other browsers have applied them: the host reads a room through the
 * same REST API, so once Liveblocks has them, a read will see them.
 */
export const untilSynchronized = (
  liveblocks: LiveblocksClient,
  provider: LiveblocksYjsProvider,
) =>
  new Promise<void>((done) => {
    if (synchronized(provider)) return done();
    const unsubscribe = liveblocks.events.syncStatus.subscribe(() => {
      if (!synchronized(provider)) return;
      unsubscribe();
      done();
    });
  });

/**
 * This machine's own copy, kept under the entry's id.
 *
 * Keyed by entry rather than by session so that the next tab to open the same
 * file finds it -- which is the whole point: work reaches here the moment it
 * is typed, and outlives the tab that typed it.
 */
export const persisting: Persist = (entry, doc) => {
  const kept = new IndexeddbPersistence(`wsfs:${entry}`, doc);
  return {
    loaded: kept.whenSynced.then(() => undefined),
    stop: async () => {
      /**
       * The flush is best effort, and it has to be.
       *
       * A store that is already closing -- a second teardown, a browser
       * tearing the page down around this -- throws from `storeState`, and
       * that throw used to travel: `Rooms.dispose` waits on all its rooms
       * together, so one room whose connection had gone abandoned the flush
       * of every OTHER room beside it. Losing one room's last update is bad;
       * losing everybody's because of it is the thing worth preventing.
       */
      try {
        await storeState(kept, true);
      } catch {
        /** Nothing to do about it, and nothing worth stopping for. */
      }
      try {
        await kept.destroy();
      } catch {
        /** Already gone, which is where this was trying to get to. */
      }
    },
  };
};

/**
 * Everything a room asks of this host.
 *
 * Taken FROM THE CLIENT rather than built from a path and a bare `fetch`.
 * These endpoints are scoped by workspace and authorised like every other,
 * and a hand-built path had nowhere to keep either -- which is how they went
 * on calling routes that had moved, and then calling them unauthenticated.
 */
export const hostedIn = (workspace: Pick<Workspace, "room">): Host => ({
  settle: (entry) => workspace.room.settle(entry),
  stored: (entry, version) => workspace.room.stored(entry, version),
  handOver: (entry, update) => workspace.room.handOver(entry, update),
});

export const enteringWith = (liveblocks: LiveblocksClient) =>
  ((entry, doc) => {
    const entered = liveblocks.enterRoom(entry);
    const provider = new LiveblocksYjsProvider(entered.room, doc);
    return {
      provider: Object.assign(provider, {
        ahead: () => provider.getStatus() === "synchronizing",
        handedOver: () => untilSynchronized(liveblocks, provider),
        watch: (changed: () => void) =>
          liveblocks.events.syncStatus.subscribe(changed),
      }),
      leave: () => entered.leave(),
    };
  }) satisfies ConstructorParameters<typeof Rooms>[1];
