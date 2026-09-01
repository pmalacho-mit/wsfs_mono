export { default as Kernel, type Environment, type Run } from "./Kernel";
export { Output } from "./output";
export { contents, type Contents } from "./contents";
export { base64, type Awaitable } from "./utils";
export type { FileSystem, HostFileSystem } from "./fs";
import { output } from "./Snippets.svelte";

export const snippets = { output };
