/**
 * Wiring a room to the two things around it: this host, and this machine.
 *
 * NO VENDOR HERE. What a room needs of the host is three of the host's own
 * routes, and what it needs of the machine is somewhere to put a document
 * between visits -- neither of which is a collaboration service's business.
 * The service itself is entered through `Enter`, and the implementations of
 * that live beside this file, one per vendor.
 */
import { IndexeddbPersistence, storeState } from "y-indexeddb";

import type { Host, Persist } from "../room";
import type { Workspace } from "../workspace";

/**
 * Asking the host to fill a room now, so opening the file later is instant.
 */
export const warmRoom = async (
  workspace: Pick<Workspace, "room">,
  entry: string,
): Promise<void> => {
  await workspace.room.warm(entry);
};

/**
 * This machine's own copy, kept under the entry's id.
 *
 * Keyed by entry rather than by session so that the next tab to open the same
 * file finds it -- which is the whole point: work reaches here the moment it
 * is typed, and outlives the tab that typed it.
 */
export const persisting: Persist = (entry, doc) => {
  const persistence = new IndexeddbPersistence(`wsfs:${entry}`, doc);
  return {
    loaded: persistence.whenSynced.then(() => undefined),
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
        await storeState(persistence, true);
      } catch {
        /** Nothing to do about it, and nothing worth stopping for. */
      }
      try {
        await persistence.destroy();
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
  bringRoomUpToFile: (entry) => workspace.room.bringRoomUpToFile(entry),
  stored: (entry, version) => workspace.room.stored(entry, version),
  handOver: (entry, update) => workspace.room.handOver(entry, update),
});
