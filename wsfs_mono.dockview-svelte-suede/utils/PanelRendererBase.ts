import type { PanelUpdateEvent, Parameters } from "dockview";
import { type Component, mount, unmount } from "svelte";
import {
  PropsUpdater,
  type PropsPostProcessor,
} from "./PropsUpdater.svelte.js";
import type { RecordLike, Mounted } from "./types.js";
import { MountMechanism, type IdentifierRecipe } from "./MountMechanism.js";
import { prefix } from "./index.js";

export type PanelRendererBaseConfig<
  Props extends RecordLike,
  InitOptions extends RecordLike
> = {
  /**
   * Function to be invoked when the panel's `init` method is called,
   * which is responsible for converting the first argument ("options") of `init`
   * into the props ultimately passed to the Svelte component.
   * @param options
   * @returns
   */
  initOptionsToProps: (options: InitOptions) => Props;
  /**
   * The Svelte component to be rendered in the panel.
   */
  svelteComponent: Component<Props>;
  /**
   * An optional function to be invoked after the props are updated.
   * @param props
   */
  propsPostProcessor?: PropsPostProcessor<Props>;
  element?: HTMLElement;
} & IdentifierRecipe;

export default class PanelRendererBase<
  Props extends RecordLike,
  InitOptions extends RecordLike
> {
  static Mount = new MountMechanism();
  protected readonly mountID: ReturnType<MountMechanism["id"]>;

  protected readonly svelteComponent: Component<Props>;
  protected readonly _element: HTMLElement;

  protected instance?: Mounted<Props>;
  protected readonly initOptionsToProps: (options: InitOptions) => Props;
  protected readonly propsPostProcessor?: PropsPostProcessor<Props>;

  /** The params as last written, to compare the next update against. */
  private readonly written: Parameters = {};

  propsUpdater?: PropsUpdater<Props>;

  get element(): HTMLElement {
    return this._element;
  }

  constructor(config: PanelRendererBaseConfig<Props, InitOptions>) {
    this.mountID = PanelRendererBase.Mount.id(config);
    this.svelteComponent = config.svelteComponent;
    this.initOptionsToProps = config.initOptionsToProps;
    this.propsPostProcessor = config.propsPostProcessor;
    this._element = config.element ?? document.createElement("div");
    this._element.classList.add("dv-react-part");
    this._element.style.height = "100%";
    this._element.style.width = "100%";
    this._element.setAttribute(
      "data-dockview-svelte",
      PanelRendererBase.ReadableIdentifier(config)
    );
    if (!this._element.id) this._element.id = this.mountID;
  }

  public init(options: InitOptions): void {
    const props = this.initOptionsToProps(options);

    /** Read before the props become reactive, so these are the raw values. */
    Object.assign(this.written, props.params);

    this.propsUpdater = new PropsUpdater(props, this.propsPostProcessor);

    this.instance = mount(this.svelteComponent, {
      target: this.element,
      props: this.propsUpdater.props,
    });

    PanelRendererBase.Mount.tryResolveAndDrop(this.mountID, this.instance);
  }

  dispose(): void {
    if (this.instance) unmount(this.instance);
  }

  update({ params }: PanelUpdateEvent): void {
    const changed = this.changed(params);
    if (changed)
      this.propsUpdater?.updateMany(
        "params",
        changed as Partial<Props["params"]>
      );
  }

  /**
   * Dockview re-sends every param on every update, and writing one back is
   * not free even when it has not changed: Svelte wraps an object value in a
   * fresh proxy on assignment, which invalidates everything reading it.
   */
  private changed(params: Parameters): Parameters | undefined {
    let changed: Parameters | undefined;

    for (const key in params) {
      if (this.written[key] === params[key]) continue;
      this.written[key] = params[key];
      (changed ??= {})[key] = params[key];
    }

    return changed;
  }

  private static ReadableIdentifier = ({
    panelTarget,
    viewIndex,
    id,
    name,
  }: PanelRendererBaseConfig<any, any>) =>
    `${panelTarget}-${viewIndex}-${
      id.startsWith(prefix.component) ? "component" : "snippet"
    }-${name}`;
}

export type ConstructorConfigWithout<
  Props extends RecordLike,
  InitOptions extends RecordLike,
  K extends keyof PanelRendererBaseConfig<Props, InitOptions> =
    | "panelTarget"
    | "initOptionsToProps"
> = Omit<PanelRendererBaseConfig<Props, InitOptions>, K>;
