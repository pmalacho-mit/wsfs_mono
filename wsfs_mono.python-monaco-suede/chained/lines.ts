/** One file as it appears inside another's prelude. */
export type Link = { uri: string; text: string };

export type Origin = { uri: string; line: number };

const lineCount = (text: string) => text.split("\n").length;

const preludeOf = (preceding: Link[]) =>
  preceding.map((link) => `${link.text}\n`).join("");

const offsetOf = (preceding: Link[]) =>
  preceding.reduce((total, link) => total + lineCount(link.text), 0);

const linkContaining = (preceding: Link[], line: number): Origin | undefined => {
  let remaining = line;
  for (const link of preceding) {
    const height = lineCount(link.text);
    if (remaining < height) return { uri: link.uri, line: remaining };
    remaining -= height;
  }
  return undefined;
};

/**
 * A chained document is analysed as its own text prefixed with every earlier
 * file in the chain, which is how a name bound in one becomes visible in the
 * next. Everything the prefix shifts is expressed here as line arithmetic.
 */
export const chainedDocument = (preceding: Link[], text: string) =>
  preludeOf(preceding) + text;

export const preludeOffset = offsetOf;

export const originOf = linkContaining;
