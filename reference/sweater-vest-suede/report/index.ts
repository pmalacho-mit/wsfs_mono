import { writeFile } from "node:fs/promises";
import devcontainer from "../../sweater-vest-suede.programmatic-docker-suede/devcontainer.js";
import { container } from "../../sweater-vest-suede.programmatic-docker-suede";
import {
  buildAndRun,
  certificates,
  playwright,
  sessionWithTabs,
  type Browser,
  type Forwarded,
  browsers,
} from "../../sweater-vest-suede.browser-control-container-suede";
import { cli } from "../../sweater-vest-suede.typescript-cli-suede";
import { startReportServer, type ReportServer } from "./events.ts";
import { printReport } from "./print.ts";
import { renderMarkdown } from "./markdown.ts";
import { readableTimestamp, sort, type Expand } from "../utils/index.ts";
import { getOrDefaults } from "../utils/options.ts";
import type { TestResult } from "./events.ts";

export { renderMarkdown } from "./markdown.ts";
export type { TestResult, Event } from "./events.ts";

type SessionWithTabs = Awaited<ReturnType<typeof sessionWithTabs>>;

export namespace Report {
  export type Server = ReportServer;

  export type Options = {
    /** URL where the development server is running. */
    server?: string;
    /** Endpoint where Closet.svelte is rendered (relative to the server URL). */
    closet?: string;
    /** Browsers to run. */
    browsers?: Browser[];
    /** Output path for the Markdown report. Pass an empty string to skip. */
    output?: string;
    /** Only open components whose path matches this pattern. */
    component?: RegExp;
    /** Only run tests whose name or id matches this pattern. */
    test?: RegExp;
    /**
     * Ports to publish on the browser's own loopback address, so that a page
     * served from one counts as a trustworthy origin. Only such an origin is
     * given SharedArrayBuffer, service workers and the rest of the
     * secure-context APIs — reaching the same server at the devcontainer's
     * address is not enough, and the page gives no hint why.
     *
     * Point `server` at `http://localhost:<port>` to use them.
     */
    forward?: Forwarded[];
    /**
     * How long the run may go without a word from any browser before it is
     * given up on. Raise it for a suite whose slowest single test is longer
     * than this — booting a language runtime, downloading a large asset.
     */
    silenceMs?: number;
    /**
     * Certificates the browser should trust, by path on this machine.
     * Defaults to the roots this machine has been given beyond its
     * distribution's — an intercepting proxy's CA, typically, without which
     * the browser cannot reach what this machine can.
     */
    trustCertificates?: string[];
  };

  /**
   * Structured types for report data, used internally and by renderers.
   * Expresses the remapping of raw TestResult data into a hierarchy of components, containers, and tests,
   * and their execution in a specific browser environment (which should be more intuitive to work with / render),
   */
  export namespace Result {
    /** The execution of a specific test on a specific browser */
    export type Run = Expand<
      Pick<TestResult, "status" | "error" | "durationMs" | "artifacts"> & {
        browser: Browser;
      }
    >;
    export type Test = Expand<
      Omit<TestResult, keyof Run | "container" | "component"> & {
        runs: Run[];
      }
    >;
    export type Container = TestResult["container"] & {
      tests: Test[];
    };
    export type Component = Pick<TestResult, "component"> & {
      containers: Container[];
    };
    export type Summary = {
      total: number;
      passed: number;
      failed: number;
      skipped: number;
      results: Component[];
    };
  }

  export type RenderInput = {
    generatedAt: string;
    closet: string;
    results: Result.Component[];
  };
}

export const defaults = {
  server: `http://${devcontainer.ip()}:5173`,
  closet: `/`,
  browsers: ["chromium"],
  output: "./fashion-show.md",
} as const satisfies Report.Options;

/**
 * Names are scoped by devcontainer id so that a browser container is reused
 * across runs from the same devcontainer and never shared with another one.
 * The id comes from the hostname rather than an inspect, which the daemon
 * cannot answer when it runs inside the devcontainer (docker-in-docker).
 */
const namer = async () => {
  const scope = await devcontainer.id();
  const timestamp = readableTimestamp();
  return {
    container: (browser) => `${browser}-sweater-vest-${scope}`,
    session: (browser) => `${browser}-sweater-vest-${timestamp}`,
  } satisfies Record<string, (browser: Browser) => string>;
};

const session = async (
  browser: Browser,
  { container, session }: Awaited<ReturnType<typeof namer>>,
) => sessionWithTabs(container(browser), session(browser), browser);

export type SearchParam = "component" | "reportServer" | "testFilter";

const urls = {
  param: ({ searchParams }: URL, key: SearchParam, value: string) =>
    searchParams.set(key, value),
  closet: (options: Pick<Report.Options, "server" | "closet">) => {
    const { server, closet } = getOrDefaults(
      options,
      defaults,
      "server",
      "closet",
    );
    return new URL(closet, server);
  },
  discover: (
    options: Pick<Report.Options, "server" | "closet">,
    server: ReportServer,
  ) => {
    const url = urls.closet(options);
    urls.param(url, "reportServer", `${server.url}/discover`);
    return url.toString();
  },
  test: (
    options: Pick<Report.Options, "server" | "closet">,
    server: ReportServer,
    browser: Browser,
    component: string,
    testPattern?: RegExp,
  ) => {
    const url = urls.closet(options);
    urls.param(url, "component", component);
    urls.param(url, "reportServer", `${server.url}/${browser}`);
    if (testPattern) urls.param(url, "testFilter", testPattern.source);
    return url.toString();
  },
};

const findOrCreate = Object.assign(
  (
    map: Map<string, Report.Result.Component>,
    component: string,
    result: TestResult,
  ) =>
    findOrCreate.test(
      findOrCreate.container(findOrCreate.component(map, component), result),
      result,
    ),
  {
    component: (
      map: Map<string, Report.Result.Component>,
      component: string,
    ) => {
      const entry = map.get(component) ?? { component, containers: [] };
      if (!map.has(component)) map.set(component, entry);
      return entry;
    },
    container: (component: Report.Result.Component, result: TestResult) => {
      const existing = component.containers.find(
        ({ index }) => index === result.container.index,
      );
      if (existing) return existing;
      const length = component.containers.push({
        ...result.container,
        tests: [],
      });
      return component.containers[length - 1];
    },
    test: (container: Report.Result.Container, result: TestResult) => {
      const existing = container.tests.find(
        ({ index }) => index === result.index,
      );
      if (existing) return existing;
      const length = container.tests.push({
        name: result.name,
        id: result.id,
        index: result.index,
        runs: [],
      });
      return container.tests[length - 1];
    },
  },
);

const components = (server: Report.Server, options: Report.Options) => {
  const { component } = getOrDefaults(options, defaults, "component");
  return server.paths.then((paths) =>
    component ? paths.filter((path) => component.test(path)) : paths,
  );
};

const results = async (
  server: Report.Server,
  options: Report.Options,
  sessions: Map<Browser, SessionWithTabs>,
): Promise<Report.Result.Component[]> => {
  const { browsers, test } = getOrDefaults(
    options,
    defaults,
    "browsers",
    "test",
  );

  const results = await Promise.all(
    (await components(server, options)).flatMap((component) =>
      browsers.map(async (browser) => {
        const url = urls.test(options, server, browser, component, test);
        await sessions.get(browser)!.newTab(url);
        const testResults = await server.waitForComponent(browser, component);
        return testResults.map((result) => ({ component, browser, result }));
      }),
    ),
  );

  const byComponent = new Map<string, Report.Result.Component>();

  for (const { component, browser, result } of results.flat())
    findOrCreate(byComponent, component, result).runs.push({
      browser,
      status: result.status,
      error: result.error,
      durationMs: result.durationMs,
      artifacts: result.artifacts,
    });

  const sorted = [...byComponent.values()];

  for (const component of sorted)
    for (const container of component.containers.sort(sort.byIndex))
      container.tests.sort(sort.byIndex);

  return sorted;
};

const onStatus = (status: TestResult["status"]) => (run: Report.Result.Run) =>
  run.status === status;

const summarize = (results: Report.Result.Component[]) => {
  const flat = results.flatMap(({ containers }) =>
    containers.flatMap(({ tests }) => tests.flatMap(({ runs }) => runs)),
  );
  return {
    results,
    total: flat.length,
    passed: flat.filter(onStatus("passed")).length,
    failed: flat.filter(onStatus("failed")).length,
    skipped: flat.filter(onStatus("skipped")).length,
  } satisfies Report.Result.Summary;
};

const tryRenderMarkdown = async (
  input: Report.RenderInput,
  options: Report.Options,
) => {
  const { output } = getOrDefaults(options, defaults, "output");
  if (!output) return;
  await writeFile(output, renderMarkdown(input), "utf-8");
  console.log(`Report written to ${output}`);
};

export const generateReport = async (
  options: Report.Options = {},
): Promise<Report.Result.Summary | undefined> => {
  const { closet, browsers, output } = getOrDefaults(
    options,
    defaults,
    "browsers",
    "closet",
    "output",
  );

  let server: ReportServer | undefined;

  const names = await namer();

  try {
    const prepare = async (browser: Browser) => {
      const name = names.container(browser);
      await buildAndRun(browser, {
        container: () => name,
        network: await devcontainer.network(),
        log: true,
        forward: options.forward ?? [],
        trustCertificates: options.trustCertificates ?? (await certificates.local()),
        skipIfRunning: true, // can re-use browser container specific to this devcontainer
      });
      await playwright.ready(name);
    };

    /**
     * SERIAL, and that is the whole point of it.
     *
     * `prepare` BUILDS THE IMAGE as well as creating the container, so running
     * it concurrently is what puts two playwright installs and then two
     * `runc create`s in flight at once. That is the state the docker daemon
     * has wedged in twice -- every client stuck in uninterruptible sleep, with
     * `dockerd` still alive and even `_ping` hanging, and no way back from
     * inside the devcontainer. It is not resource exhaustion; there was disk
     * and memory to spare both times.
     *
     * Nothing is lost by waiting. A cached image creates in about a second,
     * and the first run of a browser pays for its image once either way --
     * the only difference is whether it pays alone.
     */
    for (const browser of browsers) await prepare(browser);

    const sessions = new Map<Browser, SessionWithTabs>();
    await Promise.all(
      browsers.map(async (browser) =>
        sessions.set(browser, await session(browser, names)),
      ),
    );

    server = await startReportServer(options.silenceMs);

    const discover = (browser: Browser) =>
      sessions.get(browser)!.newTab(urls.discover(options, server!));

    await Promise.all(browsers.map(discover));

    const reported: Report.RenderInput = {
      closet,
      generatedAt: new Date().toISOString(),
      results: await results(server, options, sessions),
    };

    printReport(reported, { output });
    await tryRenderMarkdown(reported, options);
    return summarize(reported.results);
  } catch (e) {
    console.error("Report generation failed:", e);
  } finally {
    server?.close();
    await Promise.allSettled(
      browsers.map((browser) =>
        playwright
          .close(names.container(browser), names.session(browser))
          .catch(() => {}),
      ),
    );
    await Promise.allSettled(
      browsers.map((browser) => container.tryRemove(names.container(browser))),
    );
  }
};

const ports = (list: string): Forwarded[] =>
  list
    .split(",")
    .map((port) => Number(port.trim()))
    .filter((port) => Number.isInteger(port) && port > 0);

if (cli.entry(import.meta.url)) {
  const { server, closet, browser, output, test, component, forward, silence } =
    cli(
    "Run the sweater vest report script.",
    cli.flag(
      ["server", "s"],
      "URL where the development server is running.",
      defaults.server,
    ),
    cli.flag(
      ["closet", "c"],
      "Endpoint where Closet.svelte is rendered (relative to the server URL).",
      defaults.closet,
    ),
    cli.flags(
      ["browser", "b"],
      "Which browser(s) to run",
      browsers,
      defaults.browsers,
    ),
    cli.flag(
      ["output", "o"],
      "Output path for the Markdown report. Pass an empty string to skip.",
      defaults.output,
    ),
    cli.flag(
      ["test", "t"],
      "Only run tests whose name or id matches this pattern.",
    ),
    cli.flag(
      ["component", "m"],
      "Only open components whose path matches this pattern.",
    ),
    cli.flag(
      ["forward", "f"],
      "Ports to publish on the browser's localhost, comma separated, so that " +
        "pages served from them are trustworthy origins.",
      "",
    ),
    cli.flag(
      ["silence", "w"],
      "Seconds a run may go without a word from any browser before it is " +
        "given up on.",
      0,
    ),
  );

  generateReport({
    server,
    closet,
    output,
    browsers: browser,
    forward: ports(forward),
    silenceMs: silence > 0 ? silence * 1000 : undefined,
    component: component ? new RegExp(component, "i") : undefined,
    test: test ? new RegExp(test, "i") : undefined,
  })
    .then((summary) => {
      if ((summary?.failed ?? 1) > 0) process.exit(1);
    })
    .catch((e) => {
      console.error("Report generation failed:", e);
      process.exit(1);
    });
}
