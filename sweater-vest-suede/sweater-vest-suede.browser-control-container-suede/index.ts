import { resolve } from "node:path";
import {
  container,
  image,
} from "../browser-control-container-suede.programmatic-docker-suede";
import devcontainer from "../browser-control-container-suede.programmatic-docker-suede/devcontainer.js";
import CommandStream, {
  type CompletedResult,
} from "../browser-control-container-suede.programmatic-docker-suede/CommandStream.js";
import defaults from "./defaults.js";
import { certificates } from "./certificates.js";
import { encode as encodeForwards, type Forwarded } from "./forward.js";

export { certificates } from "./certificates.js";
export type { Forward, Forwarded } from "./forward.js";

/**
 * Currently, `chrome` is not supported on Apple Silicon due to Playwright's bundled Chromium not supporting ARM64 Linux.
 * This is supposed to be fixed in Q2 2026: https://blog.google/chromium/bringing-chrome-to-arm64-linux-devices/
 */
export const browsers = [
  "chromium",
  "firefox",
  "webkit",
  /** chrome */
] as const;
export type Browser = (typeof browsers)[number];

const __dirname = resolve(import.meta.dirname);
const context = resolve(__dirname, "docker");

type Options = Partial<
  typeof defaults & {
    onBuild: (stream: CommandStream) => void;
    log: boolean;
    network: string;
    skipIfRunning?: boolean;
    /**
     * Ports to make reachable on the browser's own loopback address, so pages
     * served from them count as trustworthy origins. See {@link Forward}.
     */
    forward: Forwarded[];
    /**
     * Certificates the browser should trust, as paths on this machine.
     * {@link certificates.local} finds the ones this machine already trusts.
     */
    trustCertificates: string[];
  }
>;

const forwardedBy = (info: { Config?: { Env?: string[] | null } }) =>
  (info.Config?.Env ?? [])
    .find((entry) => entry.startsWith("FORWARD="))
    ?.slice("FORWARD=".length) ?? "";

/**
 * The id of the running container named `name`, when it already forwards what
 * is being asked for and so can be reused; otherwise nothing.
 *
 * The id, rather than a boolean, because reusing resolves the handle by it —
 * see {@link buildAndRun}.
 */
const reusableId = async (name: string, forward: string) => {
  if (!(await container.isRunning(name))) return undefined;
  const info = await container.inspect(name);
  return forwardedBy(info) === forward ? info.Id : undefined;
};

/**
 *
 * @param BROWSER
 * @param details
 * @returns
 * @throws
 */
export const buildAndRun = async (BROWSER: Browser, details?: Options) => {
  const name = (details?.container ?? defaults.container)(BROWSER);

  /**
   * `/forward.mjs` is what serves the forwards, and it is the default command
   * rather than something the container does on its own. Replacing the command
   * without running it would leave `FORWARD` set and nothing acting on it —
   * forwards would silently do nothing, and a container in that state still
   * looks correctly configured to {@link reusableId}.
   */
  if (details?.forward?.length && details?.command)
    throw new Error(
      "A custom `command` must run /forward.mjs itself to serve `forward`; " +
        "otherwise the forwarded ports are never listened on.",
    );

  const forward = await encodeForwards(details?.forward ?? [], details?.network);
  const trusted = details?.trustCertificates ?? [];

  const reusable = details?.skipIfRunning
    ? await reusableId(name, forward)
    : undefined;

  if (reusable) {
    if (details?.log)
      console.log(
        `Reusing existing running container for ${BROWSER} (${name})`,
      );
    await certificates.install(name, trusted);
    /**
     * Resolved by id rather than by name, so the handle this returns reports
     * the same `id` that `container.run` below does. Resolving by name would
     * hand back a handle whose `id` is the name, which works against the API
     * but does not compare equal to the one a freshly started container has.
     */
    return container.resolve(reusable);
  }

  const tag = (details?.image ?? defaults.image)(BROWSER);

  if (details?.log)
    console.log(`(Try) Removing existing container for ${BROWSER}`);
  await container.tryRemove(name);

  if (details?.log) console.log(`Building image ${tag} from ${context}...`);

  const build = await image.build(tag, context, { buildargs: { BROWSER } });

  details?.onBuild?.(build);

  if (details?.log)
    for await (const chunk of build.chunks())
      process[chunk.kind === "err" ? "stderr" : "stdout"].write(chunk.data);

  const { exit, err } = await build.complete();

  if (exit !== 0)
    throw new Error(`Build failed for ${tag} with error:\n${err}`);

  const network = details?.network ?? (await devcontainer.network());

  const command = details?.command ?? defaults.command;
  const started = await container.run({
    network,
    name,
    command,
    image: tag,
    env: { FORWARD: forward },
  });

  await certificates.install(name, trusted);
  return started;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type PlaywrightCliOptions = {
  session?: string;
  /** output response as JSON */
  json?: boolean;
  /** output only the result value, without status and code */
  raw?: boolean;
};

export const playwright = {
  args: (args: string[], options?: PlaywrightCliOptions) => [
    "playwright-cli",
    ...(options?.session ? [`-s=${options.session}`] : []),
    ...(options?.json ? ["--json"] : []),
    ...(options?.raw ? ["--raw"] : []),
    ...args,
  ],
  exec: (name: string, args: string[], options?: PlaywrightCliOptions) =>
    container.exec(name, playwright.args(args, options)),
  /** CLI does not return non-zero exit codes on error */
  errored: async (stream: CommandStream) => {
    const { out } = await stream.complete();
    return out.startsWith("### Error\n");
  },
  run: async (
    container: string,
    args: string[],
    options?: PlaywrightCliOptions,
  ) => {
    const result = await playwright.exec(container, args, options).complete();

    if (result.exit !== 0)
      throw new Error(`playwright-cli ${args[0]} failed: ${result.err}`);

    return result;
  },
  json: async <T>(
    container: string,
    args: string[],
    options?: Omit<PlaywrightCliOptions, "json">,
  ) => {
    const result = await playwright.run(container, args, {
      ...options,
      json: true,
    });
    return result.out.trim() ? (JSON.parse(result.out) as T) : undefined;
  },
  open: (
    container: string,
    browser: Browser,
    session: string,
    url: string = "about:blank",
  ) =>
    playwright.run(container, ["open", url, "--browser", browser], { session }),
  close: (container: string, session: string) =>
    playwright.run(container, ["close"], { session }),
  list: (container: string) =>
    playwright
      .json<{ browsers: Array<Record<string, unknown>> }>(container, ["list"])
      .then((result) => result?.browsers ?? []),
  ready: async (
    name: string,
    maxAttempts: number = 20,
    delayMs: number = 250,
  ): Promise<void> => {
    for (let i = 0; i < maxAttempts; i++) {
      if (await container.isRunning(name))
        if (await playwright.json(name, ["list"])) return;
      await sleep(delayMs);
    }
    throw new Error(`Playwright CLI not ready in container ${name}`);
  },
  parseCurrentTab: ({ out }: CompletedResult) => {
    const match = out.match(/^- (\d+):\s*\(current\)/m);
    if (match) return parseInt(match[1], 10);
    throw new Error(
      `Failed to get current tab index from output after creating tab:\n${out}`,
    );
  },

  newTab: async (
    container: string,
    url: string = "about:blank",
    session?: string,
  ) =>
    playwright
      .run(container, ["tab-new", url], { session, raw: true })
      .then(playwright.parseCurrentTab),

  selectTab: async (container: string, index: number, session?: string) => {
    const result = playwright.parseCurrentTab(
      await playwright.run(container, ["tab-select", index.toString()], {
        session,
        raw: true,
      }),
    );
    if (result !== index)
      throw new Error(
        `Failed to select tab ${index}, current tab is ${result}`,
      );
  },

  console: async (container: string, session?: string) =>
    playwright
      .run(container, ["console"], { session, raw: true })
      .then(({ out }) => out),

  evaluate: async <Return>(
    container: string,
    fn: () => Return,
    session?: string,
  ) =>
    playwright
      .run(container, ["eval", fn.toString()], { session, raw: true })
      .then(({ out }) =>
        out && out.trim() !== "undefined"
          ? (JSON.parse(out.trim()) as Return)
          : undefined,
      ),
};

export const sessionWithTabs = async (
  container: string,
  session: string,
  browser: Browser,
) => {
  await playwright.open(container, browser, session);

  const selectTab = (index: number) =>
    playwright.selectTab(container, index, session);

  let queue = Promise.resolve();

  /**
   * No-op used to advance the tail of a promise chain,
   * regardless of success/failure so it never stalls.
   */
  const advance = () => {};

  /**
   * A session has one current tab, and the CLI both moves it and reports it.
   * Interleaving two such commands misattributes the reported index to the
   * wrong caller, so they all run one at a time.
   */
  const againstCurrentTab = <Return>(fn: () => Return) => {
    const result = queue.then(fn) as Promise<Awaited<Return>>;
    queue = result.then(advance, advance);
    return result;
  };

  const withTabSelected = <Return>(index: number, fn: () => Return) =>
    againstCurrentTab(async () => {
      await selectTab(index);
      return fn();
    });

  return {
    selectTab,
    withTabSelected,
    newTab: (url: string = "about:blank") =>
      againstCurrentTab(() => playwright.newTab(container, url, session)),
    evaluateOnTab: <Return>(index: number, fn: () => Return) =>
      withTabSelected(index, () =>
        playwright.evaluate<Return>(container, fn, session),
      ),
    consoleForTab: (index: number) =>
      withTabSelected(index, () => playwright.console(container, session)),
  };
};

export const readFile = (name: string, path: string) =>
  container.exec(name, ["cat", path]).complete({ out: "buffer" });
