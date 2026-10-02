/**
 * Selector matching against our DOM.
 *
 * Supports what the MVP needs: type, universal, id, class, attribute,
 * descendant, child, adjacent-sibling and general-sibling combinators, plus the
 * structural pseudo-classes `:first-child`, `:last-child`, `:nth-child()` and
 * `:root`.
 */

import type { DomElement } from "../html/dom";
import { isElement } from "../html/dom";
import type { CompoundSelector, SimpleSelector } from "./parse";

/** Pseudo-classes that describe state and therefore never match a static document. */
const NEVER_MATCHING_PSEUDO_CLASSES = new Set([
  "hover",
  "focus",
  "focus-visible",
  "focus-within",
  "active",
  "visited",
  "link",
  "target",
  "checked",
  "disabled",
  "enabled",
  "required",
  "optional",
  "valid",
  "invalid",
  "in-range",
  "out-of-range",
  "placeholder-shown",
  "read-only",
  "read-write",
  "indeterminate",
  "default",
  "playing",
  "paused",
  "muted",
  "fullscreen",
]);

function matchesAttribute(el: DomElement, attribute: CompoundSelector["attributes"][number]): boolean {
  const actual = el.attributes[attribute.name];
  if (actual === undefined) return false;
  const expected = attribute.value;
  switch (attribute.operator) {
    case "":
      return true;
    case "=":
      return actual === expected;
    case "~=":
      return actual.split(/\s+/).includes(expected);
    case "|=":
      return actual === expected || actual.startsWith(`${expected}-`);
    case "^=":
      return expected !== "" && actual.startsWith(expected);
    case "$=":
      return expected !== "" && actual.endsWith(expected);
    case "*=":
      return expected !== "" && actual.includes(expected);
    default:
      return false;
  }
}

function elementSiblings(el: DomElement): DomElement[] {
  const parent = el.parent;
  if (!parent) return [el];
  return parent.children.filter((child): child is DomElement => isElement(child));
}

function matchesNth(el: DomElement, argument: string, fromEnd = false): boolean {
  const parent = el.parent;
  if (!parent) return false;
  const siblings = parent.children.filter((child): child is DomElement => isElement(child));
  const position = siblings.indexOf(el) + 1;
  const index = fromEnd ? siblings.length - position + 1 : position;
  return matchesNthIndex(index, argument);
}

/** Evaluate an `an+b` expression against a 1-based position. */
function matchesNthIndex(index: number, argument: string): boolean {
  const expr = argument.trim().toLowerCase();
  if (expr === "odd") return index % 2 === 1;
  if (expr === "even") return index % 2 === 0;

  const normalized = expr.replace(/\s+/g, "");
  const match = /^([+-]?\d*)n([+-]\d+)?$/.exec(normalized);
  if (match) {
    const rawA = match[1]!;
    const a = rawA === "" || rawA === "+" ? 1 : rawA === "-" ? -1 : parseInt(rawA, 10);
    const b = match[2] ? parseInt(match[2], 10) : 0;
    if (a === 0) return index === b;
    const quotient = (index - b) / a;
    return Number.isInteger(quotient) && quotient >= 0;
  }

  const exact = parseInt(normalized, 10);
  return Number.isFinite(exact) && index === exact;
}

function matchesPseudoClass(el: DomElement, name: string, argument: string): boolean {
  switch (name) {
    case "root":
      return el.parent === null || (el.parent.tagName === "div" && !el.parent.attributes.style);
    case "first-child":
      return elementSiblings(el)[0] === el;
    case "last-child": {
      const siblings = elementSiblings(el);
      return siblings[siblings.length - 1] === el;
    }
    case "only-child":
      return elementSiblings(el).length === 1;
    case "first-of-type":
      return elementSiblings(el).filter((s) => s.tagName === el.tagName)[0] === el;
    case "last-of-type": {
      const sameType = elementSiblings(el).filter((s) => s.tagName === el.tagName);
      return sameType[sameType.length - 1] === el;
    }
    case "nth-child":
      return matchesNth(el, argument);
    case "nth-last-child":
      return matchesNth(el, argument, true);
    case "only-of-type":
      return elementSiblings(el).filter((s) => s.tagName === el.tagName).length === 1;
    case "not":
      return parseSimpleNegation(argument).every((negated) => !matchesCompound(el, negated));
    case "empty":
      return el.children.length === 0;
    default:
      // Every remaining pseudo-class describes state that a static document
      // never reaches, so it simply does not match.
      return NEVER_MATCHING_PSEUDO_CLASSES.has(name) ? false : false;
  }
}

function parseSimpleNegation(argument: string): CompoundSelector[] {
  const out: CompoundSelector[] = [];
  for (const part of argument.split(",")) {
    const trimmed = part.trim().replace(/^:/, "");
    const classes = [...trimmed.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!);
    const id = /^#([\w-]+)/.exec(trimmed)?.[1] ?? null;
    const tag = /^([a-z][\w-]*)/i.exec(trimmed)?.[1]?.toLowerCase() ?? null;
    if (classes.length > 0 || id || tag) {
      out.push({
        tagName: tag,
        id,
        classes,
        attributes: [],
        pseudoClasses: [],
        pseudoElements: [],
      });
    }
  }
  return out;
}

function matchesCompound(el: DomElement, compound: CompoundSelector): boolean {
  if (compound.tagName && compound.tagName !== el.tagName) return false;
  if (compound.id && el.attributes.id !== compound.id) return false;
  for (const className of compound.classes) {
    const classes = (el.attributes.class ?? "").split(/\s+/);
    if (!classes.includes(className)) return false;
  }
  for (const attribute of compound.attributes) {
    if (!matchesAttribute(el, attribute)) return false;
  }
  for (const pseudo of compound.pseudoClasses) {
    if (pseudo.name === "before" || pseudo.name === "after") continue;
    if (!matchesPseudoClass(el, pseudo.name, pseudo.argument)) return false;
  }
  for (const pseudo of compound.pseudoElements) {
    // `::before`/`::after` have no DOM node; everything else never matches.
    if (pseudo !== "before" && pseudo !== "after") return false;
  }
  return true;
}

function matchesFrom(el: DomElement, selector: SimpleSelector, compoundIndex: number): boolean {
  const compound = selector.compounds[compoundIndex]!;
  if (!matchesCompound(el, compound)) return false;
  if (compoundIndex === 0) return true;

  const combinator = selector.combinators[compoundIndex - 1]!;
  const parent = el.parent;
  switch (combinator) {
    case "child":
      return parent !== null && matchesFrom(parent, selector, compoundIndex - 1);
    case "descendant": {
      let ancestor = parent;
      while (ancestor) {
        if (matchesFrom(ancestor, selector, compoundIndex - 1)) return true;
        ancestor = ancestor.parent;
      }
      return false;
    }
    case "adjacent": {
      if (!parent) return false;
      const siblings = parent.children.filter((child): child is DomElement => isElement(child));
      const index = siblings.indexOf(el);
      const previous = siblings[index - 1];
      return previous !== undefined && matchesFrom(previous, selector, compoundIndex - 1);
    }
    case "sibling": {
      if (!parent) return false;
      const siblings = parent.children.filter((child): child is DomElement => isElement(child));
      const index = siblings.indexOf(el);
      for (let i = index - 1; i >= 0; i -= 1) {
        if (matchesFrom(siblings[i]!, selector, compoundIndex - 1)) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/** True when `selector` matches `el`. */
export function matchesSelector(el: DomElement, selector: SimpleSelector): boolean {
  return matchesFrom(el, selector, selector.compounds.length - 1);
}