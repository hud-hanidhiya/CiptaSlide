/**
 * A minimal, tree-shaped HTML DOM.
 *
 * parse5 already produces a tree; this module defines the narrow shape the
 * conversion pipeline actually consumes. Keeping our own node type means the
 * rest of the pipeline never depends on parse5's adapter internals, and tests
 * can build fixtures without going through the parser.
 */

export interface DomElement {
  kind: "element";
  /** Lower-case tag name, e.g. `h1`, `div`. */
  tagName: string;
  /** Original-case tag name as authored. */
  rawTagName: string;
  attributes: Record<string, string>;
  children: DomNode[];
  parent: DomElement | null;
}

export interface DomText {
  kind: "text";
  /** Decoded text content; entity references already resolved by the parser. */
  value: string;
  parent: DomElement | null;
}

export interface DomComment {
  kind: "comment";
  value: string;
  parent: DomElement | null;
}

export type DomNode = DomElement | DomText | DomComment;

/** Build an element node with the given attributes and children. */
export function createElement(
  tagName: string,
  attributes: Record<string, string> = {},
  children: DomNode[] = [],
  rawTagName?: string,
): DomElement {
  const el: DomElement = {
    kind: "element",
    tagName: tagName.toLowerCase(),
    rawTagName: rawTagName ?? tagName,
    attributes,
    children,
    parent: null,
  };
  for (const child of children) child.parent = el;
  return el;
}

/** Build a text node. */
export function createText(value: string): DomText {
  return { kind: "text", value, parent: null };
}

/** Type guard for element nodes. */
export function isElement(node: DomNode): node is DomElement {
  return node.kind === "element";
}

/** Type guard for text nodes. */
export function isText(node: DomNode): node is DomText {
  return node.kind === "text";
}

/** Type guard for comment nodes. */
export function isComment(node: DomNode): node is DomComment {
  return node.kind === "comment";
}

/** Iterate only the element children of a node. */
export function elementChildren(node: DomNode): DomElement[] {
  return node.kind === "element"
    ? node.children.filter((c): c is DomElement => c.kind === "element")
    : [];
}

/** Read an attribute, returning undefined when absent. Empty string stays "". */
export function attr(el: DomElement, name: string): string | undefined {
  return el.attributes[name.toLowerCase()];
}

/** Read a boolean-ish HTML attribute (`data-pptx-ignore`, `disabled`, ...). */
export function boolAttr(el: DomElement, name: string): boolean {
  const value = attr(el, name);
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "true" || normalized === "1";
}

/** Walk every element in the subtree, depth-first, including `root`. */
export function walkElements(root: DomElement): DomElement[] {
  const out: DomElement[] = [];
  const visit = (el: DomElement): void => {
    out.push(el);
    for (const child of el.children) {
      if (child.kind === "element") visit(child);
    }
  };
  visit(root);
  return out;
}

/** Concatenated text content of a subtree, with whitespace collapsed. */
export function textContent(node: DomNode): string {
  if (isText(node)) return node.value;
  if (isComment(node)) return "";
  return node.children.map(textContent).join("");
}

/** Concatenated text content with runs of whitespace collapsed to one space. */
export function collapsedTextContent(node: DomNode): string {
  return textContent(node).replace(/\s+/g, " ").trim();
}

/** Remove a node from its parent's child list. */
export function removeNode(node: DomNode): void {
  const parent = node.parent;
  if (!parent) return;
  const index = parent.children.indexOf(node);
  if (index >= 0) parent.children.splice(index, 1);
  node.parent = null;
}

/** Replace `node` with `replacement` in its parent's child list. */
export function replaceNode(node: DomNode, replacement: DomNode): void {
  const parent = node.parent;
  if (!parent) return;
  const index = parent.children.indexOf(node);
  if (index < 0) return;
  replacement.parent = parent;
  parent.children[index] = replacement;
  node.parent = null;
}

/** Deep structural clone, dropping parent links. */
export function cloneElement(el: DomElement): DomElement {
  return createElement(
    el.tagName,
    { ...el.attributes },
    el.children.map((child) => {
      if (isText(child)) return createText(child.value);
      if (isComment(child)) return { kind: "comment" as const, value: child.value, parent: null };
      return cloneElement(child);
    }),
    el.rawTagName,
  );
}