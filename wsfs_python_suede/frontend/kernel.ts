/**
 * A pool of Python kernels, and where they see the workspace from.
 *
 * A KERNEL IS EXPENSIVE AND SINGLE-USE. Starting one is seconds of Pyodide
 * coming up, and a program that ran and left globals behind is not a clean
 * place to run the next one -- so the pool keeps a warm one ready and never
 * hands the same one out twice. See `WarmPool`.
 *
 * WHAT PYTHON READS IS WHAT THE EDITOR SHOWS, and that is the whole reason
 * `override` is not optional here. The kernel's filesystem answers from the
 * client's own state, synchronously, because Python blocks while it waits --
 * and an editor holding a buffer somebody is typing into knows something the
 * filesystem does not. Core deliberately does not decide who else to trust;
 * this is the consumer that has one.
 */
import type {
  FileOverride,
  Workspace,
} from "../../wsfs_core_suede/frontend";
import { WarmPool } from "../../wsfs_svelte_suede/frontend";
import { Kernel } from "../../python-web-kernel-suede";
import fs from "../../python-web-kernel-suede/fs";
import { filesystem } from "./adapters/kernel";

/** Where the workspace is mounted inside the kernel. */
export const ROOT = "/home/pyodide";

export type KernelPool = WarmPool<Kernel>;

export const kernels = (
  workspace: Workspace,
  override: FileOverride,
  { ask = (prompt: string) => window.prompt(prompt) ?? "" } = {},
): KernelPool =>
  new WarmPool<Kernel>({
    create: () =>
      new Kernel({
        fs: fs.readWrite({ ...filesystem(workspace, override), root: ROOT }),
        input: async (prompt) => ask(prompt),
      }),
  });
