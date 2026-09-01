import type { Expand } from "./utils";
import type { MultilineString, IOutput } from "@jupyterlab/nbformat";
import type { ImagePayload } from "./pyodide/modules";
import { renderToString } from "katex";

export namespace Output {
  export type Any = IOutput;
  export type Type = "stream" | "display_data" | "execute_result" | "error";
  export type Map = Expand<
    {
      [t in Type]: Extract<Any, { output_type: t }>;
    } & {
      unrecognizable: Exclude<Any, { output_type: Type }>;
    }
  >;
  export type Specific<T extends Type = Type> = Map[T];
  export type Stream = Specific<"stream">;
  export type DisplayData = Specific<"display_data">;
  export type ExecuteResult = Specific<"execute_result">;
  export type Error = Specific<"error">;
}

const keys = {
  stream: {
    out: "stdout",
    err: "stderr",
  },
  execute_result: {
    html: "text/html",
    plain: "text/plain",
  },
  display_data: {
    image: "image/png",
    animation: "image/gif",
  },
} as const;

export const is = <T extends Output.Type>(
  query: Output.Any,
  target: T,
): query is Output.Specific<T> => query.output_type === target;

type ErrorProperties = Pick<Output.Error, "ename" | "evalue" | "traceback">;

const src = (type: string, base64: string) =>
  base64.startsWith("data:image/") ? base64 : `data:${type};base64,${base64}`;

export function accessor(output: Output.Error): ErrorProperties;
export function accessor(
  output: Output.Stream,
): Partial<Record<"out" | "err", MultilineString>>;
export function accessor(
  output: Output.ExecuteResult,
): Partial<Record<"html" | "plain", string>>;
export function accessor(
  output: Output.DisplayData,
): Partial<Record<"image", string>>;
export function accessor(
  output: Output.Specific,
): Partial<Record<string, MultilineString>> {
  if (is(output, "error"))
    return output satisfies ErrorProperties as ErrorProperties;

  if (is(output, "stream"))
    return {
      get out() {
        return output.name === keys.stream.out ? output.text : undefined;
      },
      get err() {
        return output.name === keys.stream.err ? output.text : undefined;
      },
    };

  const get = (key: string) => {
    const data = output.data[key];
    if (!data) return undefined;
    if (typeof data === "string") return data;
    throw new Error(`Output ${key} is not a string`);
  };

  if (is(output, "execute_result"))
    return {
      get html() {
        return get(keys.execute_result.html);
      },
      get plain() {
        return get(keys.execute_result.plain);
      },
    };
  else if (is(output, "display_data"))
    return {
      get image() {
        const animation = get(keys.display_data.animation);
        if (animation) return src(keys.display_data.animation, animation);
        const image = get(keys.display_data.image);
        return image ? src(keys.display_data.image, image) : undefined;
      },
    };

  throw new Error("Unreachable");
}

export function make(
  output: "stream",
  name: keyof typeof keys.stream,
  text: MultilineString,
): Output.Stream;
export function make(
  output: "execute_result",
  type: keyof typeof keys.execute_result | "latex",
  data: string,
): Output.ExecuteResult;
export function make(
  output: "display_data",
  type: keyof typeof keys.display_data,
  payload: ImagePayload,
): Output.DisplayData;
export function make(output: "error", payload: ErrorProperties): Output.Error;
export function make(
  output: Output.Type,
  second: string | ErrorProperties,
  third?: MultilineString | ImagePayload,
): Output.Specific {
  switch (output) {
    case "stream":
      return {
        output_type: "stream",
        name: keys.stream[second as keyof typeof keys.stream],
        text: third as MultilineString,
      };
    case "execute_result":
      const type = second as keyof typeof keys.execute_result | "latex";
      let value = third as string;

      const key =
        type === "latex" ? keys.execute_result.html : keys.execute_result[type];

      if (type === "latex")
        value = renderToString(value.replace(/^(\$?\$?)([^]*)\1$/, "$2"), {
          throwOnError: false,
          errorColor: " #cc0000",
          displayMode: true,
        });

      return {
        execution_count: null,
        metadata: {},
        output_type: "execute_result",
        data: { [key]: value },
      };
    case "display_data":
      const { width, height, base64, format } = third as ImagePayload;
      const mimeType =
        format === "gif"
          ? keys.display_data.animation
          : keys.display_data.image;
      return {
        output_type: "display_data",
        metadata: { width, height },
        data: { [mimeType]: src(mimeType, base64) },
      };
    case "error":
      const { ename, evalue, traceback } = second as ErrorProperties;
      return {
        output_type: "error",
        ename,
        evalue,
        traceback,
      };
    default:
      throw new Error(`Unknown output type: ${output}`);
  }
}

export const Output = {
  is,
  accessor,
  make,
};
