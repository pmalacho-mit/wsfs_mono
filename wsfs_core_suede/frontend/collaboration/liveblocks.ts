/**
 * Liveblocks, as an `Enter`.
 *
 * A NAMED ADAPTER AND NOT A DEFAULT, and the only file in this package that
 * imports a collaboration vendor. Nothing else here may: a consumer that
 * reaches a vendor's client through `wsfs_core_suede` has taken a dependency
 * nobody declared, and the import audit fails the build over exactly this
 * file's contents appearing anywhere else.
 */
import { createClient } from "@liveblocks/client";
import { LiveblocksYjsProvider } from "@liveblocks/yjs";

import type { Enter } from "../room";

type LiveblocksClient = ReturnType<typeof createClient>;

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
  }) satisfies Enter;
