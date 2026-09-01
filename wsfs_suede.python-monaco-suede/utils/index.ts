export const relative = (path: string) => path.replace(/^\/+/, "");

export const join = (...parts: string[]) =>
  parts
    .map((part, index, { length }) =>
      index === 0
        ? part.replace(/\/+$/, "")
        : index === length - 1
          ? part.replace(/^\/+/, "")
          : part.replace(/^\/+|\/+$/g, ""),
    )
    .filter(Boolean)
    .join("/");

export const debounce = <T extends unknown[]>(
  milliseconds: number,
  run: (...args: T) => void,
) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: T) => {
    clearTimeout(timer);
    timer = setTimeout(() => run(...args), milliseconds);
  };
};

export const singletonify = <T extends Record<string, () => any>>(
  getters: T,
): { [K in keyof T]: ReturnType<T[K]> } => {
  const instances = new Map<string, ReturnType<T[keyof T]>>();
  let self: { [K in keyof T]: ReturnType<T[K]> };
  self = new Proxy<typeof self>({} as typeof self, {
    get(_, key: string) {
      if (!instances.has(key)) instances.set(key, getters[key]());
      return instances.get(key);
    },
  });
  return self;
};

/** A promise something else decides the moment of. */
export const latch = () => {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return { opened, release };
};
