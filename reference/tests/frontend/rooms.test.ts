/**
 * Whether a shared document still speaks for its file.
 *
 * All that is left of a module that used to decide what a room owed. The
 * verdicts and the bookkeeping went when the server took over carrying text
 * into rooms -- see `rooms.ts`. This rule was never about transport, so it
 * stayed.
 */
import { describe, expect, it } from "vitest";

import { speaking } from "../../release/frontend/rooms";

describe("whether a room may write its file back", () => {
  it("may, when it is reaching the others and owes nothing", () => {
    expect(speaking({ attached: true, behind: false })).toBe(true);
  });

  it("may not while it owes a catch-up, even though it is connected", () => {
    expect(speaking({ attached: true, behind: true })).toBe(false);
  });

  /**
   * The half that is not obvious. A member that has lost the room can still
   * reach the server, and what it holds is not wrong -- it is simply not
   * shared. Storing it tells everybody else about a write whose content is
   * still in flight, and they are handed it twice: once carried in, once when
   * this member's own copy arrives.
   */
  it("may not while it is reaching nobody, however much it has caught up", () => {
    expect(speaking({ attached: false, behind: false })).toBe(false);
  });

  it("may not when it is both away and behind", () => {
    expect(speaking({ attached: false, behind: true })).toBe(false);
  });
});
