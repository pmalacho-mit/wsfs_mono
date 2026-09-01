/**
 * A workspace with nobody behind it.
 *
 * Enough of the wire to draw the shell: entries for the tree, content for the
 * editor, and a stream that never says anything. Every mutation is refused,
 * so what this shows is the optimistic view and only that -- which is all a
 * picture of the layout needs, and is why nothing here belongs in the app.
 */
import { v4 as uuid } from "uuid";
import type { Transport } from "$wsfs";
import type { Metadata } from "../../../../../release/frontend/contract";

/** What a folder and its files look like: `{ "src": { "main.py": "..." } }`. */
export type Layout = Record<string, Record<string, string>>;

/** Everything the server would have decided, decided once and never again. */
const stamped = (
  name: string,
  type: Metadata["type"],
  parent: string | null,
  content: string | null,
): Metadata => ({
  id: uuid(),
  type,
  name,
  parent,
  deleted: false,
  name_version: uuid(),
  parent_version: uuid(),
  deleted_version: uuid(),
  content_version: content === null ? null : uuid(),
  modified: { accepted: new Date().toISOString(), minted: null, offset: null },
});

const flatten = (layout: Layout) => {
  const entries: Metadata[] = [];
  const held = new Map<string, string>();
  for (const [name, files] of Object.entries(layout)) {
    const holder = stamped(name, "folder", null, null);
    entries.push(holder);
    for (const [file, content] of Object.entries(files)) {
      const entry = stamped(file, "file", holder.id, content);
      entries.push(entry);
      held.set(entry.id, content);
    }
  }
  return { entries, held };
};

export const offline = (layout: Layout): Transport => {
  const { entries, held } = flatten(layout);
  const token = uuid();

  return {
    initialize: async () => ({ token, entries, applied: [], rejected: [] }),
    submit: async () => ({ rejected: true, reason: "nothing is listening" }),
    content: async (_workspace, entry) => ({
      kind: "text",
      text: held.get(entry) ?? "",
    }),
    store: async () => {},
    /** Nothing was ever written here, so nothing has ever been said. */
    history: async () => ({ versions: [], more: false }),
    /** And no room was ever filled: this is a picture, not a session. */
    settleRoom: async () => null,
    warmRoom: async () => {},
    roomStored: async () => {},
    handOver: async () => {},
    /** Nobody is listening, so nobody is answering either. */
    ask: async () => {
      throw new Error("nothing is listening");
    },
    hear: async function* () {},
    conversation: async () => ({ turns: [], more: false }),
    progress: async () => ({ progressing: true, why: "" }),
    /** A picture is not a term, and nothing here is being studied. */
    detected: async () => {},
    accepted: async () => {},
    activity: async () => {},
    /** Nothing was ever kept here, so there is nothing to say has reached anybody. */
    cleared: async () => {},
    follow: () => ({ close: () => {} }),
  };
};
