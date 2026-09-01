import { relative } from "../utils";

export type FileProvider = {
  paths: () => Iterable<string> | Promise<Iterable<string>>;
  read: (path: string) => string | Promise<string>;
  write?: (path: string, text: string) => void | Promise<void>;
  watch?: (listen: FileProvider.Listener) => FileProvider.Unsubscribe;
};

export namespace FileProvider {
  export type Change = {
    path: string;
    kind: "added" | "changed" | "removed";
  };
  export type Listener = (change: Change) => void;
  export type Unsubscribe = () => void;

  export class Memory implements FileProvider {
    private contents = new Map<string, string>();
    private listeners = new Set<Listener>();

    paths = () => [...this.contents.keys()];

    read = (path: string) => {
      const content = this.contents.get(relative(path));
      if (content === undefined) throw new Error(`No such file: ${path}`);
      return content;
    };

    write = (path: string, text: string) => {
      const kind = this.contents.has(relative(path)) ? "changed" : "added";
      this.contents.set(relative(path), text);
      this.announce({ path: relative(path), kind });
    };

    remove = (path: string) => {
      if (!this.contents.delete(relative(path))) return;
      this.announce({ path: relative(path), kind: "removed" });
    };

    has = (path: string) => this.contents.has(relative(path));

    watch = (listen: Listener) => {
      this.listeners.add(listen);
      return () => this.listeners.delete(listen);
    };

    private announce = (change: Change) =>
      this.listeners.forEach((listen) => listen(change));
  }
}
