/**
 * The wire, named.
 *
 * Every type here is this package's generated schema under a shorter name.
 * Nothing is declared by hand: if a shape drifts, `generate.py` moves it and
 * this file stops compiling, which is the point.
 */
import type { components } from "./schema.generated";

type Schemas = components["schemas"];

export type { Id } from "../../wsfs_core_suede/frontend/contract";

export type Judging = Schemas["Judging"];
export type Judged = Schemas["Judged"];

/**
 * The study's records -- see the backend's `study.py` for why these are the
 * one part of this contract a client is allowed to post and forget about.
 */
export type Detected = Schemas["Detected"];
export type Accepted = Schemas["Accepted"];
export type Recorded = Schemas["Recorded"];
export type Moment = Schemas["Moment"];
export type Span = Schemas["Span"];
