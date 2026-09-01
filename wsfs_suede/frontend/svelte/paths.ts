/** The two halves of a path, named once so both components agree. */
export const nameOf = (path: string) => path.split("/").pop() ?? path;

export const holderOf = (path: string) => path.split("/").slice(0, -1).join("/");
