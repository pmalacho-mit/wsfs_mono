import type { Report } from ".";

/**
 * How a report renders each part of a result. Both the stdout summary and the
 * Markdown report read from here, so the two can never name the same test —
 * or round the same duration — differently.
 */
export const display = {
  duration: (milliseconds: number) =>
    milliseconds >= 1000
      ? `${(milliseconds / 1000).toFixed(2)}s`
      : `${milliseconds}ms`,

  component: (path: string) =>
    path
      .replace(/^\/+/, "")
      .replace(/^(src|lib|packages\/[^/]+\/src)\//, "")
      .replace(/\.test\.svelte$/, "")
      .replace(/\.svelte$/, ""),

  container: (container: Report.Result.Container) =>
    container.category ?? `container ${container.index + 1}`,

  /** Falls back to the position of an unnamed test, which still identifies it. */
  test: (test: Report.Result.Test) =>
    test.name ?? test.components ?? `test ${test.index + 1}`,
};
