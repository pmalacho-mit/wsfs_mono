/**
 * Asking before a page with unsent work is left.
 *
 * WHAT THE PROMPT IS AND IS NOT. `beforeunload` runs synchronously and
 * nothing can be awaited inside it, so this does not buy time to save --
 * clicking "Leave" ends the page as immediately as it would have without it.
 * What it buys is the other answer: a person who did not mean to close the
 * tab gets to stay, and staying is what gives the ordinary write, with its
 * outbox and its retries, the time it needs. The last-resort paths still run
 * either way; see `Workspace.rescue` and `stash.ts`.
 *
 * The browser chooses the words. Every one of them has ignored a custom
 * string since about 2017 and shows its own "changes you made may not be
 * saved", so there is nothing here to write.
 *
 * REGISTERED ONLY WHILE SOMETHING IS AT RISK, which is the whole reason this
 * is a module and not one `addEventListener`. A page carrying a
 * `beforeunload` listener is disqualified from the back/forward cache in
 * several browsers -- the penalty is for HAVING the listener, not for firing
 * it -- and this app deliberately avoided it everywhere else for exactly that
 * reason. Holding the listener only for the seconds between a keystroke and
 * the write that carries it is what makes the trade worth taking: navigating
 * back into a workspace stays instant in every moment where there was nothing
 * to lose anyway.
 */
const held = new Set<string>();

let detach: (() => void) | undefined;

const ask = (event: BeforeUnloadEvent) => {
  /**
   * Both, because they are two eras of the same API: `preventDefault` is what
   * the specification says now, and a truthy `returnValue` is what several
   * shipping browsers still read. Neither displays the value.
   */
  event.preventDefault();
  event.returnValue = "";
};

const attach = () => {
  if (detach !== undefined || typeof window === "undefined") return;
  window.addEventListener("beforeunload", ask);
  detach = () => window.removeEventListener("beforeunload", ask);
};

const release_ = () => {
  detach?.();
  detach = undefined;
};

/**
 * Says this file is holding text nobody else has yet.
 *
 * Keyed, and idempotent, because the question is about the WORKSPACE and the
 * answer is a set: two dirty files are one prompt, and the second one going
 * clean must not take the prompt away from the first.
 */
export const hold = (id: string): void => {
  held.add(id);
  attach();
};

/** Says it is not any more, whichever way the text left. */
export const release = (id: string): void => {
  held.delete(id);
  if (held.size === 0) release_();
};

/** Whether anything is still holding work that has not been sent. */
export const anythingUnsaved = (): boolean => held.size > 0;

/**
 * Forgets everything, and stops asking.
 *
 * For a workspace being torn down: its files are gone, so their claims on the
 * prompt are too, and leaving them behind would leave a page that asks about
 * work that no longer exists anywhere.
 */
export const forgetAll = (): void => {
  held.clear();
  release_();
};
