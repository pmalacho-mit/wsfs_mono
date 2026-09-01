import type {
  DockviewApi,
  GridviewApi,
  IGridviewPanel,
  IDockviewPanel,
  IPaneviewPanel,
  ISplitviewPanel,
  SplitviewApi,
  PaneviewApi,
  GridviewPanelApi,
  PaneviewPanelApi,
  SplitviewPanelApi,
  GridviewOptions,
  DockviewOptions,
  SplitviewOptions,
  PaneviewOptions,
  GridviewFrameworkOptions,
  DockviewFrameworkOptions,
  SplitviewFrameworkOptions,
  PaneviewFrameworkOptions,
  IDockviewPanelProps,
  IDockviewPanelHeaderProps,
  IWatermarkPanelProps,
  IDockviewHeaderActionsProps,
  ITabGroupChipRenderer,
  IGroupDragGhostRenderer,
  DockviewGroupPanel,
  Orientation,
} from "dockview";
import { type Component, type Snippet } from "svelte";
import SnippetRender from "./SnippetRender.svelte";
import type {
  RecordLike,
  RequiredAndPartial,
  ComponentExports,
  ConstrainedComponent,
  OmitNever,
  AsNonReadonly,
  Expand,
} from "./types.js";
import PanelRendererBase from "./PanelRendererBase.js";
import ReactivePanelUpdater, {
  claimReactives,
} from "./reactivity.svelte.js";
import type { ThemeSetting } from "./themes";

/** The listener a view api event is subscribed with. */
type Listener<Event> = Event extends (listener: infer L) => any ? L : never;

/**
 * Drop callbacks are taken as props rather than left to the consumer to
 * subscribe, and each is typed by the event it is subscribed to.
 */
type DropProps<Api, Keys extends keyof Api> = {
  [K in Keys]?: Listener<Api[K]>;
};

/** Every view reports itself ready by handing back its api. */
type ReadyProp<ViewType extends ViewKey> = {
  onReady: (event: { api: RawViewAPIs[ViewType] }) => void;
};

/**
 * The props each view component takes before this library customizes them:
 * everything dockview's own options carry, plus what the view reports back.
 */
export type ViewPropsByView = {
  grid: GridviewOptions & ReadyProp<"grid">;
  dock: DockviewOptions &
    ReadyProp<"dock"> &
    DropProps<DockviewApi, "onDidDrop" | "onWillDrop">;
  pane: PaneviewOptions & ReadyProp<"pane"> & DropProps<PaneviewApi, "onDidDrop">;
  split: SplitviewOptions & ReadyProp<"split">;
};

/** The keys of the different view types */
export type ViewKey = keyof ViewPropsByView;

/** What a panel component is handed: its params, its own api, and its view's. */
type PanelProps<Api, ContainerApi, T extends RecordLike> = {
  params: T;
  api: Api;
  containerApi: ContainerApi;
};

/** The props of the components underlying the added panels within the different views */
export type PanelComponentPropsByView<T extends RecordLike = any> = {
  grid: PanelProps<GridviewPanelApi, GridviewApi, T>;
  dock: IDockviewPanelProps<T>;
  pane: PanelProps<PaneviewPanelApi, PaneviewApi, T> & { title: string };
  split: PanelProps<SplitviewPanelApi, SplitviewApi, T>;
};

export type PanelComponentProps<T extends ViewKey = ViewKey> =
  PanelComponentPropsByView[T];

export type OriginalPanelPropKeys<T extends ViewKey = ViewKey> =
  keyof PanelComponentProps<T>;

/** The type of the panel returned by `api.addPanel` for the different views */
export type AddedPanelByView<T extends ViewKey = ViewKey> = {
  grid: IGridviewPanel;
  dock: IDockviewPanel;
  pane: IPaneviewPanel;
  split: ISplitviewPanel;
}[T];

/** A collection of svelte components (v5 / "runes mode" and/or v4 / "legacy mode") that can be used as panel componets (their props are restricted according to the view type) */
export type ComponentsConstraint<ViewType extends ViewKey> = Record<
  string,
  Exclude<
    Component<PanelComponentProps<ViewType>, Record<string, any>, any>,
    () => Symbol
  >
>;

export type CustomComponentConstraint<Props extends Record<string, any>> =
  Record<string, Component<Props, Record<string, any>, any>>;

/** A collection of snippets that can be used as panel componets (their props are restricted according to the view type) */
export type SnippetsConstraint<ViewType extends ViewKey> = Record<
  string,
  Snippet<[PanelComponentProps<ViewType>]>
>;

export type CustomSnippetsConstraint<Props extends Record<string, any>> =
  Record<string, Snippet<[Props]>>;

/** A collection of the different component types that can be used as header components for Pane views */
export type PanePanelHeaderConstraint = {
  components: ComponentsConstraint<"pane">;
  snippets: SnippetsConstraint<"pane">;
};

export type DockviewTabConstraint = {
  components: CustomComponentConstraint<IDockviewPanelHeaderProps>;
  snippets: CustomSnippetsConstraint<IDockviewPanelHeaderProps>;
};

type SnippetOrComponentTuple<TProps extends Record<string, any>> =
  | { component: CustomComponentConstraint<TProps>[string] }
  | { snippet: CustomSnippetsConstraint<TProps>[string] };

/**
 * What a tab context menu is rendered with. Deliberately the argument shape
 * upstream's `IContextMenuItemComponentProps` carries, so a later licence
 * purchase is a swap rather than a rewrite.
 */
export type ITabContextMenuProps = {
  panel: IDockviewPanel;
  group: DockviewGroupPanel;
  api: DockviewApi;
  /** Call to close the context menu */
  close: () => void;
};

/** What a tab group chip is rendered with, straight off the renderer contract. */
export type ITabGroupChipProps = Parameters<ITabGroupChipRenderer["init"]>[0];

/** What the ghost following the cursor during a group drag is rendered with. */
export type IGroupDragGhostProps = Parameters<
  IGroupDragGhostRenderer["init"]
>[0];

export type DockviewSpecificComponentConstraint = {
  watermark: SnippetOrComponentTuple<IWatermarkPanelProps>;
  tabGroupChip: SnippetOrComponentTuple<ITabGroupChipProps>;
  groupDragGhost: SnippetOrComponentTuple<IGroupDragGhostProps>;
  tabContextMenu: SnippetOrComponentTuple<ITabContextMenuProps>;
  defaultTab: SnippetOrComponentTuple<IDockviewPanelHeaderProps>;
  rightHeaderActions: SnippetOrComponentTuple<IDockviewHeaderActionsProps>;
  leftHeaderActions: SnippetOrComponentTuple<IDockviewHeaderActionsProps>;
  prefixHeaderActions: SnippetOrComponentTuple<IDockviewHeaderActionsProps>;
};

/**
 * A type that takes panel props for each view type and selectively requires certain keys while keeping others optional.
 * The Required parameter controls which keys from the original panel props become required.
 */
export type SelectivelyRequiredPanelComponentPropsByView<
  T extends RecordLike = RecordLike,
  Required extends OriginalPanelPropKeys = "params"
> = {
  [ViewType in ViewKey]: RequiredAndPartial<
    PanelComponentPropsByView<T>[ViewType],
    Required
  >;
};

export type FrameworkOptions<ViewType extends ViewKey> = {
  grid: GridviewFrameworkOptions;
  dock: DockviewFrameworkOptions;
  pane: PaneviewFrameworkOptions;
  split: SplitviewFrameworkOptions;
}[ViewType];

/** The options `api.addPanel` takes for a given view, before customization. */
type RawAddPanelOptions<T extends ViewKey> = Parameters<
  RawViewAPIs[T]["addPanel"]
>[0];

export type AdditionalAddPanelOptions<ViewType extends ViewKey> =
  ViewType extends "pane"
    ? /**/ { headers: PanePanelHeaderConstraint }
    : /**/ ViewType extends "dock"
    ? /**/ { tabs: DockviewTabConstraint } & DockviewSpecificComponentConstraint
    : /**/ never;

type BaseOmittedPanelOptionKeys = "id" | "component" | "params";
type OmittedPanelOptionKeysPerType<T extends ViewKey> = T extends "pane"
  ? "headerComponent"
  : never;

type CustomizedAddPanelOptions<
  T extends ViewKey,
  Additional extends AdditionalAddPanelOptions<T> = never
> = Omit<
  RawAddPanelOptions<T>,
  BaseOmittedPanelOptionKeys | OmittedPanelOptionKeysPerType<T>
> & { id?: string } & (T extends "pane"
    ? /**/ Additional extends AdditionalAddPanelOptions<"pane">
      ? /**/ {
          headerComponent?: keyof (
            | Additional["headers"]["components"]
            | Additional["headers"]["snippets"]
          );
        }
      : /**/ {}
    : /**/ {});

type ComponentPanelPropParams<
  ViewType extends ViewKey,
  K extends keyof Components,
  Components extends ComponentsConstraint<ViewType>
> = Components[K] extends Component<
  infer Props extends SelectivelyRequiredPanelComponentPropsByView[ViewType]
>
  ? Props["params"]
  : never;

type SpreadAddComponentPanelOptions<
  ViewType extends ViewKey,
  K extends keyof Components,
  Components extends ComponentsConstraint<ViewType>,
  Additional extends AdditionalAddPanelOptions<ViewType>
> = ComponentPanelPropParams<ViewType, K, Components> extends Record<
  string,
  any
>
  ? /**/ /**/
    | [ComponentPanelPropParams<ViewType, K, Components>]
      /**/
      | [
          ComponentPanelPropParams<ViewType, K, Components>,
          CustomizedAddPanelOptions<ViewType, Additional>
        ]
  : /**/ /**/
    | [null | undefined | {}, CustomizedAddPanelOptions<ViewType, Additional>]
      /**/
      | [];

type SpreadAddSnippetPanelOptions<
  ViewType extends ViewKey,
  K extends keyof Snippets,
  Snippets extends SnippetsConstraint<ViewType>,
  Additional extends AdditionalAddPanelOptions<ViewType>
> = Snippets[K] extends Snippet<
  infer Params extends [SelectivelyRequiredPanelComponentPropsByView[ViewType]]
>
  ? /**/ /**/
    | [Params[0]["params"]]
      /**/
      | [Params[0]["params"], CustomizedAddPanelOptions<ViewType, Additional>]
  : /**/ /**/
    | [null | undefined | {}, CustomizedAddPanelOptions<ViewType, Additional>]
      /**/
      | [];

export const reactive = <T>(getter: () => T): T =>
  new ReactivePanelUpdater(getter) as T;

export type ExtendedGridAPI<
  ViewType extends ViewKey,
  Components extends ComponentsConstraint<ViewType>,
  Snippets extends SnippetsConstraint<ViewType>,
  Additional extends AdditionalAddPanelOptions<ViewType> = AdditionalAddPanelOptions<ViewType>
> = {
  addComponentPanel: <K extends keyof Components & string>(
    name: string extends K ? never : K,
    ...params: SpreadAddComponentPanelOptions<
      ViewType,
      K,
      Components,
      Additional
    >
  ) => Promise<{
    exports: ComponentExports<Components[K]>;
    panel: AddedPanelByView<ViewType>;
    reference: string;
  }>;
  addSnippetPanel: <K extends keyof Snippets & string>(
    name: string extends K ? never : K,
    ...params: SpreadAddSnippetPanelOptions<ViewType, K, Snippets, Additional>
  ) => Promise<{ panel: AddedPanelByView<ViewType>; reference: string }>;

  reactive: <T>(getter: () => T) => T;
};

export type RawViewAPIs = {
  grid: GridviewApi;
  dock: DockviewApi;
  pane: PaneviewApi;
  split: SplitviewApi;
};

export type RawViewAPI<ViewType extends ViewKey = ViewKey> =
  RawViewAPIs[ViewType];

export type ViewAPI<
  ViewType extends ViewKey,
  Components extends ComponentsConstraint<ViewType>,
  Snippets extends SnippetsConstraint<ViewType>,
  Additional extends AdditionalAddPanelOptions<ViewType> = never
> = RawViewAPIs[ViewType] &
  ExtendedGridAPI<ViewType, Components, Snippets, Additional>;

type RawViewProps<ViewType extends ViewKey> = ViewPropsByView[ViewType];
type OnReady<ViewType extends ViewKey> = RawViewProps<ViewType>["onReady"];

type CustomizedViewProps<
  ViewType extends ViewKey,
  Components extends ComponentsConstraint<ViewType>,
  Snippets extends SnippetsConstraint<ViewType>,
  Additional extends AdditionalAddPanelOptions<ViewType> = never
> = {
  /**
   * CAUTION: Snippets with no arguments (like the one below) do unfortunately satisfy the `components` type costraint, but must be provided within the `snippets` object
   * @example
   * ```ts
   * {#snippet snippetWithNoArguments()}
   * {/snippet}
   *
   * <View
   *  snippets={{ snippetWithNoArguments }} // CORRECT
   *  components={{ snippetWithNoArguments }} // INCORRECT, but no type error will be shown
   * </View>
   * ```
   * */
  components?: Components;
  snippets?: Snippets;
  onReady?: (
    event: Parameters<OnReady<ViewType>>[0] & {
      api: Expand<ExtendedGridAPI<ViewType, Components, Snippets, Additional>>;
    }
  ) => ReturnType<OnReady<ViewType>>;
} & ("orientation" extends keyof RawViewProps<ViewType>
  ? { orientation: Orientation | "HORIZONTAL" | "VERTICAL" }
  : {}) &
  (ViewType extends "dock" ? { theme: ThemeSetting } : {});

/**
 * The dockview options `DockView.svelte` maps itself rather than forwards:
 * `theme` arrives as a theme *name*, and the two renderer factories arrive as
 * a component or a snippet. Forwarding any of them would push our own value
 * through as if it were the one dockview documents.
 */
export const mappedDockviewOptionKeys = [
  "theme",
  "createTabGroupChipComponent",
  "createGroupDragGhostComponent",
] as const satisfies readonly (keyof DockviewOptions)[];

export type MappedDockviewOptionKey =
  (typeof mappedDockviewOptionKeys)[number];

export type ModifiedProps<
  ViewType extends ViewKey,
  Components extends ComponentsConstraint<ViewType>,
  Snippets extends SnippetsConstraint<ViewType>,
  Additional extends AdditionalAddPanelOptions<ViewType> = never
> = Omit<
  RawViewProps<ViewType>,
  | keyof CustomizedViewProps<ViewType, Components, Snippets, Additional>
  | (ViewType extends "dock" ? MappedDockviewOptionKey : never)
  | ("orientation" extends keyof RawViewProps<ViewType> ? "orientation" : never)
> &
  CustomizedViewProps<ViewType, Components, Snippets, Additional> &
  ("orientation" extends keyof RawViewProps<ViewType>
    ? { orientation: Orientation | "HORIZONTAL" | "VERTICAL" }
    : {});

export type AdditionalPaneProps<
  Headers extends {
    components: ComponentsConstraint<"pane">;
    snippets: SnippetsConstraint<"pane">;
  }
> = {
  headers?: Partial<Headers>;
};

export const extractCoreOptions = <In extends {}, Out>(
  props: In,
  propertyKeys: (keyof In | keyof Out)[]
): Out =>
  propertyKeys.reduce((obj, key) => {
    if (key in props) obj[key as keyof Out] = props[key as keyof In] as any;
    return obj;
  }, {} as Out);

export const prefix = {
  component: "c_",
  snippet: "s_",
} as const;

type Prefix = (typeof prefix)[keyof typeof prefix];

export const createExtendedAPI = <
  ViewType extends ViewKey,
  Components extends ComponentsConstraint<ViewType>,
  Snippets extends SnippetsConstraint<ViewType>
>(
  type: ViewType,
  api: RawViewAPIs[ViewType],
  viewIndex: number
) => {
  type Target = ExtendedGridAPI<ViewType, Components, Snippets>;
  type CommonArgs =
    | SpreadAddComponentPanelOptions<
        ViewType,
        keyof Components,
        Components,
        never
      >
    | SpreadAddSnippetPanelOptions<ViewType, keyof Snippets, Snippets, never>;

  type PaneConfig = CustomizedAddPanelOptions<
    "pane",
    { headers: PanePanelHeaderConstraint }
  >;

  const common = <TExports extends RecordLike = {}>(
    prefix: Prefix,
    name: string,
    ...args: CommonArgs
  ) => {
    const withPrefix = prefix + name;
    const { length } = args;
    const params = length >= 1 ? args[0] ?? {} : {};

    const config = length === 2 ? args[1] : null;
    const id = length === 2 ? config?.id ?? withPrefix : withPrefix;

    const title = (config as any as PaneConfig)?.title ?? name;

    const promise = PanelRendererBase.Mount.await<TExports>({
      viewIndex,
      id,
      name,
      panelTarget: type,
    });

    const reactives = claimReactives(params as RecordLike);

    const panel = api.addPanel({
      ...(config ?? {}),
      id,
      title,
      component: withPrefix,
      params,
    }) as AddedPanelByView<ViewType>;

    for (const { reactive, slot } of reactives) reactive.attach(panel, slot);

    return [promise, panel, id] as const;
  };

  const addComponentPanel: Target["addComponentPanel"] = async (
    component,
    ...args
  ) => {
    type Exports = ComponentExports<Components[typeof component]>;
    const [exportsPromise, panel, reference] = common<Exports>(
      prefix.component,
      component,
      ...args
    );
    const exports = await exportsPromise;
    return { exports, panel, reference };
  };

  const addSnippetPanel: Target["addSnippetPanel"] = async (name, ...args) => {
    const [mounting, panel, reference] = common(prefix.snippet, name, ...args);
    await mounting;
    return { panel, reference };
  };

  if ("onDidRemovePanel" in api)
    api.onDidRemovePanel(ReactivePanelUpdater.Detach);
  else if ("onDidRemoveView" in api)
    api.onDidRemoveView(ReactivePanelUpdater.Detach);

  return {
    addComponentPanel,
    addSnippetPanel,
    reactive,
  } satisfies Target;
};

/** `SnippetRender` reads the snippet it renders out of `params`. */
export const snippetIntoParams =
  (select: () => Snippet<any> | undefined) =>
  (props: any): void => {
    const snippet = select();
    if (props.params?.snippet === snippet) return;
    (props.params ??= {}).snippet = snippet;
  };

const getSnippetPostProcessor = <
  ViewType extends ViewKey,
  Snippets extends SnippetsConstraint<ViewType>
>(
  snippets: Snippets,
  name: string
) => snippetIntoParams(() => snippets[name]);

const CastedSnippetRender = SnippetRender as any as ConstrainedComponent;

export const getComponentToMount = <
  ViewType extends ViewKey,
  Components extends ComponentsConstraint<ViewType>,
  Snippets extends SnippetsConstraint<ViewType>
>(
  type: ViewType,
  components: Components | undefined,
  snippets: Snippets | undefined,
  { name }: Parameters<FrameworkOptions<ViewType>["createComponent"]>[0]
) => {
  const isSnippet = name.startsWith(prefix.snippet);

  if (!isSnippet && !name.startsWith(prefix.component)) {
    const component = components?.[name] as ConstrainedComponent | undefined;
    const snippet = snippets?.[name];

    if (component && snippet)
      throw new Error(`Component '${name}' is both a component and a snippet`);
    else if (component)
      return { component, propsPostProcessor: undefined, name };
    else if (snippet) {
      const propsPostProcessor = getSnippetPostProcessor<ViewType, Snippets>(
        snippets!,
        name
      );
      return { name, component: CastedSnippetRender, propsPostProcessor };
    } else throw new Error(`Component '${name}' not found`);
  }

  const { length } = isSnippet ? prefix.snippet : prefix.component;
  const sanitized = name.slice(length);
  const component = isSnippet
    ? CastedSnippetRender
    : (components?.[sanitized]! as ConstrainedComponent);
  const propsPostProcessor = isSnippet
    ? getSnippetPostProcessor<ViewType, Snippets>(snippets!, sanitized)
    : undefined;

  return { component, propsPostProcessor, name: sanitized };
};

export type Renderables<ViewType extends ViewKey> = Record<
  string,
  ComponentsConstraint<ViewType>[string] | SnippetsConstraint<ViewType>[string]
>;

export type ExtractComponentsFromRenderables<
  ViewType extends ViewKey,
  TRenderables extends Renderables<ViewType>
> = OmitNever<{
  [k in keyof TRenderables]: TRenderables[k] extends Snippet<any>
    ? never
    : TRenderables[k] extends ComponentsConstraint<ViewType>[string]
    ? TRenderables[k]
    : never;
}>;

export type ExtractSnippetsFromRenderables<
  ViewType extends ViewKey,
  TRenderables extends Renderables<ViewType>
> = OmitNever<{
  [k in keyof TRenderables]: TRenderables[k] extends Snippet<any>
    ? TRenderables[k]
    : never;
}>;
