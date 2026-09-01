import type { MonacoBinding } from "y-monaco";

export class EditableFile {
  name: string;
  path: string;
  readonly: boolean;
  source: string;
  sourceSync?: ConstructorParameters<typeof MonacoBinding>[0];
  syncBinding?: MonacoBinding;

  constructor({
    name,
    parent,
    source = "",
    sourceSync = undefined,
    readonly = false,
  }: Pick<EditableFile, "name"> & {
    parent: Pick<EditableFile, "path">;
  } & Partial<Pick<EditableFile, "source" | "readonly" | "sourceSync">>) {
    this.name = $state(name);
    this.path = $derived(`${parent.path}/${name}`);
    this.source = $state(source);
    this.readonly = $state(readonly);
    this.sourceSync = $state(sourceSync);
    this.syncBinding = $state(undefined);
  }
}
