import type { Renderables, ViewAPI, ViewKey } from ".";
import type { Chainable, TryGet } from "./utils/types";

export const panel = <T extends ViewKey>(type?: T) => {
  type API = ViewAPI<T, Renderables<T>>;
  type ExtractConfigParameter<Key extends string> = TryGet<Key, API> extends (
    ...args: infer Args
  ) => any
    ? Args[2]
    : never;

  type ConfigParameter = Exclude<
    ExtractConfigParameter<"addSnippetPanel"> &
      ExtractConfigParameter<"addComponentPanel">,
    undefined
  >;
  type Position = TryGet<"position", ConfigParameter>;
  type Reference = string;

  type WithReference<T = any> = { reference: T };

  /** Only views that place panels relative to a group have this at all. */
  type Group = Extract<Position, { referenceGroup: unknown }>["referenceGroup"];

  /** A group itself, its api, or its id — each of them knows the id. */
  type GroupReference = [Group] extends [never]
    ? never
    : Group | { id: string };

  interface Customized {
    direction: (
      direction: TryGet<"direction", Position>
    ) => Customized & Chainable<ConfigParameter, Customized>;
    reference: (
      reference: Reference | WithReference<Reference>
    ) => Customized & Chainable<ConfigParameter, Customized>;
    group: (
      group: GroupReference
    ) => Customized & Chainable<ConfigParameter, Customized>;
    (): Exclude<ConfigParameter, undefined>;
  }

  let options = {} as Record<string, any>;

  const proxy = new Proxy(() => options, {
    get(_, prop) {
      switch (prop as keyof Customized) {
        case "direction":
          return ((direction) => {
            options["position"] ??= {};
            options["position"]["direction"] = direction;
            return proxy;
          }) satisfies Customized["direction"];
        case "reference":
          return ((reference) => {
            options["position"] ??= {};
            options["position"]["referencePanel"] =
              typeof reference === "string"
                ? reference
                : (reference as WithReference).reference;
            return proxy;
          }) satisfies Customized["reference"];
        case "group":
          return ((group) => {
            options["position"] ??= {};
            options["position"]["referenceGroup"] =
              typeof group === "string" ? group : (group as { id: string }).id;
            return proxy;
          }) satisfies Customized["group"];
        default:
          return (setting: any) => {
            options[prop as string] = setting;
            return proxy;
          };
      }
    },
  }) as Chainable<ConfigParameter, Customized> & Customized;

  return proxy;
};
