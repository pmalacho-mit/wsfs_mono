/**
 * TEMPORARY: the problem a file is an answer to.
 *
 * The workspace holds programs; it does not hold what the person was asked to
 * write. Until that lives somewhere real -- assignment metadata, a manifest
 * beside the file, whatever the course tool ends up handing us -- it lives
 * here, keyed by the name of the file the student opens.
 *
 * Keyed by NAME rather than path, and matched without regard for case, so the
 * same table answers for a file wherever it sits in a workspace and whichever
 * way its name was typed. The consequence is the obvious one: two files with
 * the same name in different folders get the same header, which is a trade
 * this table is small enough to be worth.
 *
 * The text is markdown -- it is rendered by the same renderer the tutor's
 * answers go through, so lists, emphasis and code blocks all draw the way
 * they do in the assistant panel.
 */
import { nameOf } from "./paths";

const byName = new Map<string, string>();

export const setHeaderFor = (path: string, content: string) =>
  byName.set(nameOf(path), content);

/** The problem this file is an answer to, if anybody wrote one down. */
export const headerFor = (path: string): string | undefined =>
  byName.get(nameOf(path));
