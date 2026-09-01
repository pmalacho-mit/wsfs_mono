/**
 * Where a live backend is, if one is running.
 *
 * Most of this suite is logic and needs nothing. The rest talks to a real
 * server, which is the only way to find out whether the generated types
 * describe what actually comes back -- so those tests skip when there is no
 * server rather than failing, and say so.
 */
import { describe } from "vitest";

import { http, type Transport } from "../../release/frontend";

const BASE = process.env.WSFS_BACKEND;

export const live = BASE !== undefined;

export const describeLive = live ? describe : describe.skip;

const asUser = (email: string) => async () => ({ "X-User-Email": email });

export const reachable = async (): Promise<boolean> => {
  if (!live) return false;
  try {
    return (await fetch(`${BASE}/openapi.json`)).ok;
  } catch {
    return false;
  }
};

export const transport = (email = "ada@example.com"): Transport =>
  http(`${BASE}/wsfs`, asUser(email));

/** The host's own endpoint: provisioning is not wsfs's business. */
export const project = async (email = "ada@example.com"): Promise<string> => {
  const response = await fetch(`${BASE}/projects`, {
    method: "POST",
    headers: { "X-User-Email": email },
  });
  if (!response.ok) throw new Error(`could not open a project: ${response.status}`);
  return ((await response.json()) as { id: string }).id;
};

