/// <reference types="vite/client" />

import patchMatplotlib from "./patch_matplotlib.py?raw";
import unloadLocalModules from "./unload_local_modules.py?raw";
import findImports from "./find_imports.py?raw";
import addToSysPath from "./add_to_sys_path.py?raw";

export const code = {
  patchMatplotlib,
  unloadLocalModules: (root: string) => `${unloadLocalModules}
unload_local_modules(local_roots=("${root}",))`,
  recursivelyFindExternalImports: (
    source: string,
    path: string,
  ) => `${findImports}
find_external_imports_of_local_modules(source=${JSON.stringify(source)}, path="${path}", recursive=True)`,
  micropipInstall: (packageName: string) => `import micropip
await micropip.install("${packageName}")`,
  addToSysPath: (path: string) => `${addToSysPath}
add_to_sys_path("${path}")`,
};
