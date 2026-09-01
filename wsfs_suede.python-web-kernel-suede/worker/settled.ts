/**
 * The outcome of work performed on the other side of the bridge. Errors travel
 * as data so that a thrown exception can never leave a blocked worker waiting.
 */
export type Settled<T = unknown> =
  { ok: true; value: T } | { ok: false; error: Error };

const asError = (thrown: unknown) =>
  thrown instanceof Error ? thrown : new Error(String(thrown));

export const settled = {
  capture: <T>(produce: () => T): Settled<T> => {
    try {
      return { ok: true, value: produce() };
    } catch (thrown) {
      return settled.failure(thrown);
    }
  },

  captureAsync: async <T>(
    produce: () => T | Promise<T>,
  ): Promise<Settled<T>> => {
    try {
      return { ok: true, value: await produce() };
    } catch (thrown) {
      return settled.failure(thrown);
    }
  },

  failure: (thrown: unknown): Settled<never> => ({
    ok: false,
    error: asError(thrown),
  }),

  unwrap: <T>(result: Settled<T>): T => {
    if (result.ok) return result.value;
    throw result.error;
  },
};
