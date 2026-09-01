/**
 * The wire, named.
 *
 * Every type here is this package's generated schema under a shorter name.
 * Nothing is declared by hand: if a shape drifts, `generate.py` moves it and
 * this file stops compiling, which is the point.
 *
 * THE SHARED VOCABULARY COMES FROM CORE. `Id`, `Occurrence`, `Version` and
 * `Executed` are the filesystem's, and a second declaration of them here would
 * be exactly the drift this arrangement exists to prevent.
 */
import type { components } from "./schema.generated";

type Schemas = components["schemas"];

export type {
  Id,
  Occurrence,
  Version,
  Versions,
} from "../../wsfs_core_suede/frontend/contract";

export type Asking = Schemas["Asking"];
export type Asked = Schemas["Asked"];
export type Answering = Schemas["Answering"];
export type Attaching = Schemas["Attaching"];
export type Attached = Schemas["Attached"];
export type Executed = Schemas["Executed"];
export type Turn = Schemas["Turn"];
export type Transcript = Schemas["Transcript"];
