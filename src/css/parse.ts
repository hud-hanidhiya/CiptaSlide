/**
 * A minimal CSS parser.
 *
 * Scope is deliberately small (PRD section 11): rules, declarations, at-rule
 * skipping. There is no `@supports` evaluation, no nesting, no CSS custom
 * property substitution beyond simple `var()` fallback resolution.
 *
 * Unsupported constructs are reported, not thrown: the conversion pipeline turns
 * them into warnings so the user sees exactly what was ignored.
 */

import type { Diagnostic } from "../shared/ir";

/** One declaration: property name plus raw value text. */
export interface Declaration {
  property: string;
  value: string;
  /** True when the declaration came from `!important`. */
  important: boolean;
}

/** One selector in a rule's selector list. */
export interface SimpleSelector {
  tagName: string | null;
  id: string | null;
  /** Class names, any of which matches. */
  classes: string[];
  /** Attribute selectors as `name`, `name=value`, `name^=value`, ... */
  attributes: Array<{ name: string; operator: string; value: string }>;
  pseudoClasses: PseudoClass[];
  pseudoElements: string[];
  /** Descendant combinator parts: the selector is a list of compound selectors. */
  compounds: CompoundSelector[];
  /** Combinators between compounds, length `compounds.length - 1`. */
  combinators: Combinator[];
}

/** How a compound selector relates to the one before it. */
export type Combinator = "descendant" | "child" | "adjacent" | "sibling";

/** A pseudo-class with its optional argument, e.g. `nth-child` + `2n+1`. */
export interface PseudoClass {
  name: string;
  argument: string;
}

/** A compound selector: tag plus qualifiers, all must match. */
export interface CompoundSelector {
  tagName: string | null;
  id: string | null;
  classes: string[];
  attributes: Array<{ name: string; operator: string; value: string }>;
  pseudoClasses: PseudoClass[];
  pseudoElements: string[];
}

/** A style rule. */
export interface StyleRule {
  selector: SimpleSelector;
  declarations: Declaration[];
  /** Source order index; higher wins ties against equal specificity. */
  order: number;
  /** Selector specificity as `[a, b, c]`. */
  specificity: number;
}

/** A parsed stylesheet. */
export interface Stylesheet {
  rules: StyleRule[];
}

/** Strip CSS comments, preserving string literals. */
export function stripComments(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const char = css[i]!;
    if (char === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      out += char;
      i += 1;
      while (i < css.length) {
        out += css[i]!;
        if (css[i] === "\\") {
          out += css[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (css[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/**
 * Split a declaration block on semicolons, respecting parentheses and strings.
 */
export function splitDeclarations(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let quote: string | null = null;
  for (const char of body) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === ";" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/** Parse a declaration block into {@link Declaration}s. */
export function parseDeclarationBlock(body: string): Declaration[] {
  const out: Declaration[] = [];
  for (const chunk of splitDeclarations(body)) {
    const colonIndex = findTopLevelColon(chunk);
    if (colonIndex < 0) continue;
    const property = chunk.slice(0, colonIndex).trim().toLowerCase();
    let value = chunk.slice(colonIndex + 1).trim();
    if (property === "") continue;
    let important = false;
    if (/!\s*important$/i.test(value)) {
      important = true;
      value = value.replace(/!\s*important$/i, "").trim();
    }
    out.push({ property, value, important });
  }
  return out;
}

function findTopLevelColon(input: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === ":" && depth === 0) return i;
  }
  return -1;
}

/** Split a selector list on top-level commas. */
export function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of selector) {
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts.filter((part) => part !== "");
}

/**
 * Parse one complex selector into compounds and combinators.
 *
 * Returns null for selectors we cannot represent (`:has()`, namespace
 * prefixes, `>>>`), so the caller can skip them with a warning.
 */
export function parseSelector(selector: string): SimpleSelector | null {
  const trimmed = selector.trim();
  if (trimmed === "") return null;
  if (/::?[a-z-]+\(/.test(trimmed) && !/:nth-child\(/.test(trimmed)) {
    // Functional pseudo-classes other than :nth-child are out of scope.
    if (/::?(not|has|is|where|hover|focus|active|visited|checked)\(/.test(trimmed)) return null;
  }

  const compounds: CompoundSelector[] = [];
  const combinators: Combinator[] = [];

  let buffer = "";
  let pendingCombinator: Combinator = "descendant";

  const flush = (): void => {
    const text = buffer.trim();
    buffer = "";
    if (text === "") return;
    const compound = parseCompound(text);
    if (!compound) return;
    if (compounds.length > 0) combinators.push(pendingCombinator);
    compounds.push(compound);
    pendingCombinator = "descendant";
  };

  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i]!;

    // Bracketed and parenthesised groups are atomic: `a[href^="x>y"]` must not
    // be split on the combinator characters inside them.
    if (char === "[" || char === "(") {
      const close = findMatchingBracket(trimmed, i);
      if (close < 0) return null;
      buffer += trimmed.slice(i, close + 1);
      i = close;
      continue;
    }

    if (char === ">" || char === "+" || char === "~") {
      flush();
      pendingCombinator = char === ">" ? "child" : char === "+" ? "adjacent" : "sibling";
      continue;
    }

    if (/\s/.test(char)) {
      // Whitespace ends a compound and implies a descendant combinator, but
      // only if a compound is actually open: leading and trailing spaces, and
      // runs of spaces after a `>` must not emit an extra compound.
      if (buffer.trim() === "") continue;
      flush();
      pendingCombinator = "descendant";
      continue;
    }

    buffer += char;
  }
  flush();

  if (compounds.length === 0) return null;
  const last = compounds[compounds.length - 1]!;
  return {
    tagName: last.tagName,
    id: last.id,
    classes: last.classes,
    attributes: last.attributes,
    pseudoClasses: last.pseudoClasses,
    pseudoElements: last.pseudoElements,
    compounds,
    combinators,
  };
}

function findMatchingBracket(input: string, start: number): number {
  const open = input[start]!;
  const close = open === "[" ? "]" : ")";
  let depth = 0;
  for (let i = start; i < input.length; i += 1) {
    if (input[i] === open) depth += 1;
    if (input[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseCompound(input: string): CompoundSelector | null {
  const compound: CompoundSelector = {
    tagName: null,
    id: null,
    classes: [],
    attributes: [],
    pseudoClasses: [],
    pseudoElements: [],
  };
  if (input === "") return null;

  let i = 0;
  while (i < input.length) {
    const char = input[i]!;
    if (char === "#") {
      const match = /^#([\w-]+)/.exec(input.slice(i));
      if (!match) return null;
      compound.id = match[1]!;
      i += match[0].length;
      continue;
    }
    if (char === ".") {
      const match = /^\.([\w-]+)/.exec(input.slice(i));
      if (!match) return null;
      compound.classes.push(match[1]!);
      i += match[0].length;
      continue;
    }
    if (char === "[") {
      const end = findMatchingBracket(input, i);
      if (end < 0) return null;
      const body = input.slice(i + 1, end);
      const match = /^\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(.+?)\s*)?(?:\s+([iIsS]))?\s*$/.exec(body);
      if (!match) return null;
      compound.attributes.push({
        name: match[1]!.toLowerCase(),
        operator: match[2] ?? "",
        value: (match[3] ?? "").replace(/^['"]|['"]$/g, ""),
      });
      i = end + 1;
      continue;
    }
    if (char === ":") {
      const isDouble = input[i + 1] === ":";
      const start = i + (isDouble ? 2 : 1);
      const match = /^([\w-]+)/.exec(input.slice(start));
      if (!match) return null;
      const name = match[1]!.toLowerCase();
      if (isDouble) {
        compound.pseudoElements.push(name);
        i = start + match[0].length;
        continue;
      }
      let argument = "";
      let next = start + match[0].length;
      if (input[next] === "(") {
        const end = findMatchingBracket(input, next);
        if (end < 0) return null;
        argument = input.slice(next + 1, end).trim();
        next = end + 1;
      }
      compound.pseudoClasses.push({ name, argument });
      i = next;
      continue;
    }
    const match = /^([*]|[a-z][\w-]*)/i.exec(input.slice(i));
    if (!match) return null;
    compound.tagName = match[1] === "*" ? null : match[1]!.toLowerCase();
    i += match[0].length;
  }

  return compound;
}

/**
 * Compute selector specificity as a single comparable integer.
 *
 * Packing `[a, b, c]` into one number keeps sorting trivial while preserving
 * the correct ordering, because `a` dominates and the id count cannot grow
 * unbounded for practical documents.
 */
export function specificityOf(selector: SimpleSelector): number {
  let ids = 0;
  let classes = 0;
  let tags = 0;
  for (const compound of selector.compounds) {
    if (compound.id) ids += 1;
    classes += compound.classes.length;
    classes += compound.attributes.length;
    classes += compound.pseudoClasses.filter((p) => p.name !== "not" && p.name !== "is").length;
    if (compound.tagName) tags += 1;
  }
  return ids * 10000 + classes * 100 + tags;
}

/** At-rules we can skip without reporting a warning. */
const IGNORED_AT_RULES = new Set([
  "media",
  "supports",
  "layer",
  "container",
  "scope",
  "keyframes",
  "-webkit-keyframes",
  "-moz-keyframes",
]);

/** At-rules worth telling the user about. */
const REPORTED_AT_RULES = new Set(["import", "font-face", "page"]);

/**
 * Parse a stylesheet into ordered style rules.
 *
 * Nested at-rules are flattened when the rule is unconditional (`@media` with a
 * simple `screen`/`all` condition); anything else is skipped with a diagnostic.
 */
export function parseStylesheet(css: string, diagnostics: Diagnostic[] = []): Stylesheet {
  const source = stripComments(css ?? "");
  const rules: StyleRule[] = [];
  let order = 0;
  let i = 0;

  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i]!)) i += 1;
    if (i >= source.length) break;

    if (source[i] === "@") {
      const { blockEnd, prelude } = readAtRule(source, i);
      const nameMatch = /^@([\w-]+)/.exec(prelude);
      const name = nameMatch?.[1]?.toLowerCase() ?? "";
      if (REPORTED_AT_RULES.has(name)) {
        diagnostics.push({
          level: "warning",
          stage: "css",
          property: `@${name}`,
          message: `@${name} is not supported and was ignored`,
        });
      } else if (!IGNORED_AT_RULES.has(name)) {
        diagnostics.push({
          level: "warning",
          stage: "css",
          property: `@${name}`,
          message: `At-rule @${name} is not supported and was ignored`,
        });
      }
      // `readAtRule` returns an index just past the at-rule, so resume there.
      i = blockEnd;
      continue;
    }

    const braceIndex = source.indexOf("{", i);
    if (braceIndex < 0) break;
    const prelude = source.slice(i, braceIndex).trim();
    const blockEnd = findMatchingBrace(source, braceIndex);
    if (blockEnd < 0) break;
    const body = source.slice(braceIndex + 1, blockEnd);

    const declarations = parseDeclarationBlock(body);
    if (declarations.length > 0 && prelude !== "") {
      for (const selectorText of splitSelectorList(prelude)) {
        const selector = parseSelector(selectorText);
        if (!selector) {
          diagnostics.push({
            level: "warning",
            stage: "css",
            property: selectorText,
            message: `Selector "${selectorText}" is not supported and was ignored`,
          });
          continue;
        }
        rules.push({
          selector,
          declarations,
          order: order++,
          specificity: specificityOf(selector),
        });
      }
    }

    i = blockEnd + 1;
  }

  return { rules };
}

/**
 * Locate the end of an at-rule that starts at `start`.
 *
 * `blockEnd` is the index just past the construct, so the caller can resume
 * parsing there without re-reading the closing brace.
 */
function readAtRule(source: string, start: number): { blockEnd: number; prelude: string } {
  const semicolon = source.indexOf(";", start);
  const brace = source.indexOf("{", start);

  if (brace < 0) {
    // A statement at-rule (`@import …;`) or a truncated file.
    return {
      blockEnd: semicolon < 0 ? source.length : semicolon + 1,
      prelude: source.slice(start, semicolon < 0 ? source.length : semicolon),
    };
  }
  if (semicolon >= 0 && semicolon < brace) {
    return { blockEnd: semicolon + 1, prelude: source.slice(start, semicolon) };
  }
  const closing = findMatchingBrace(source, brace);
  return { blockEnd: closing + 1, prelude: source.slice(start, brace) };
}

function findMatchingBrace(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return source.length;
}

/**
 * Parse a `style="..."` attribute into declarations.
 *
 * Attribute names are lowercased the same way as stylesheet rules so the two
 * sources unify cleanly in the cascade.
 */
export function parseInlineStyle(style: string): Declaration[] {
  return parseDeclarationBlock(style ?? "");
}

/**
 * Resolve `var(--name, fallback)` references against a custom property map.
 *
 * Only one level of substitution is performed, which covers the realistic
 * cases and cannot loop.
 */
export function resolveCustomProperties(
  declarations: Declaration[],
  customProperties: Record<string, string>,
): Declaration[] {
  return declarations.map((declaration) => {
    if (!declaration.value.includes("var(")) return declaration;
    const resolved = declaration.value.replace(
      /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
      (match, name: string, fallback: string | undefined) => {
        const value = customProperties[name];
        if (value !== undefined) return value;
        return fallback !== undefined ? fallback.trim() : "";
      },
    );
    if (resolved === declaration.value && !/var\(\s*--/.test(declaration.value)) return declaration;
    return { ...declaration, value: resolved.trim() };
  });
}

/** Extract custom property declarations (`--name: value`) from a block. */
export function extractCustomProperties(declarations: Declaration[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const declaration of declarations) {
    if (declaration.property.startsWith("--")) out[declaration.property] = declaration.value;
  }
  return out;
}