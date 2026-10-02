/**
 * HTML parsing and whitelist sanitization.
 *
 * Security posture (PRD section 24):
 *
 * - The filter is **whitelist-based**. Unknown elements and attributes are
 *   dropped, not escaped. A tag we do not understand cannot become a shape.
 * - `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<link>` and
 *   friends are removed outright, along with their subtree.
 * - Every URL-bearing attribute goes through {@link isSafeUrl}, which rejects
 *   `javascript:`, `data:text/html`, `vbscript:` and other executable schemes.
 *   `data:image/...` for raster formats is allowed because pasted base64 images
 *   are the single most common source of an inline image.
 * - Event handler attributes (`on*`) are always stripped.
 *
 * Nothing from the input is ever assigned to `innerHTML` on a live document,
 * so the classic DOM-XSS sink does not exist in this pipeline.
 */

import { parseFragment as parse5Fragment } from "parse5";

import type { Diagnostic } from "../shared/ir";
import type { DomElement, DomNode } from "./dom";
import { createElement, createText, isElement } from "./dom";

/** Tags whose entire subtree is discarded. */
const FORBIDDEN_TAGS = new Set([
  "script",
  "noscript",
  "template",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "audio",
  "video",
  "source",
  "track",
  "canvas",
  "form",
  "input",
  "button",
  "select",
  "option",
  "textarea",
  "meta",
  "base",
  "link",
]);

/**
 * Tags whose text content is CSS rather than content.
 *
 * `<style>` is hoisted out of the document during parsing and handed to the
 * stylesheet compiler, so it never reaches layout.
 */
const STYLE_TAGS = new Set(["style"]);

/** Tags kept by the sanitizer. Everything else is unwrapped or dropped. */
const ALLOWED_TAGS = new Set([
  "section",
  "article",
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "blockquote",
  "pre",
  "code",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "strike",
  "small",
  "sub",
  "sup",
  "mark",
  "a",
  "br",
  "hr",
  "img",
  "figure",
  "figcaption",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "colgroup",
  "col",
  "svg",
  "path",
  "circle",
  "rect",
  "line",
  "polygon",
  "polyline",
  "ellipse",
  "g",
  "text",
  "defs",
  "use",
  "title",
  "desc",
]);

/** Attributes allowed on every element. */
const GLOBAL_ATTRS = new Set([
  "id",
  "class",
  "style",
  "title",
  "dir",
  "lang",
  "hidden",
  "aria-label",
  "role",
]);

/** Extra attributes allowed per tag. */
const TAG_ATTRS: Record<string, string[]> = {
  a: ["href", "target", "rel"],
  img: ["src", "alt", "width", "height"],
  td: ["colspan", "rowspan", "align", "valign", "width", "height"],
  th: ["colspan", "rowspan", "align", "valign", "width", "height", "scope"],
  table: ["width", "height", "border", "cellpadding", "cellspacing"],
  col: ["width"],
  colgroup: ["span"],
  ol: ["start", "type", "reversed"],
  li: ["value"],
  svg: [
    "viewbox",
    "width",
    "height",
    "xmlns",
    "preserveaspectratio",
    "fill",
    "stroke",
    "stroke-width",
  ],
  path: ["d", "fill", "stroke", "stroke-width", "opacity"],
  circle: ["cx", "cy", "r", "fill", "stroke", "stroke-width"],
  rect: ["x", "y", "width", "height", "rx", "ry", "fill", "stroke"],
  ellipse: ["cx", "cy", "rx", "ry", "fill", "stroke"],
  line: ["x1", "y1", "x2", "y2", "stroke", "stroke-width"],
  polygon: ["points", "fill", "stroke"],
  polyline: ["points", "fill", "stroke"],
  text: ["x", "y", "fill", "font-size", "text-anchor"],
  use: ["href", "x", "y"],
};

/** URL attributes that must pass {@link isSafeUrl}. */
const URL_ATTRS = new Set(["href", "src"]);

/**
 * Attribute namespaces always allowed.
 *
 * `data-slide*` covers the slide-splitting convention, `data-pptx-*` the precise
 * layout overrides, and `data-background` the per-slide background that
 * `readSlideBackground` reads. The latter is spelled without a namespace in the
 * documented convention, so it is allowlisted explicitly.
 */
const DATA_PREFIXES = ["data-pptx-", "data-slide"];

/** `data-*` attributes allowed verbatim, on any element. */
const ALLOWED_DATA_ATTRIBUTES = new Set(["data-background"]);

/** Schemes rejected outright, regardless of nesting or whitespace tricks. */
const DANGEROUS_SCHEME_PREFIXES = [
  "javascript:",
  "vbscript:",
  "livescript:",
  "mocha:",
  "data:text/html",
  "data:application/xhtml",
  "data:image/svg+xml",
  "file:",
];

/** Schemes accepted when explicitly present. Anything else explicit is rejected. */
const ALLOWED_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/** `data:` image subtypes that are safe to inline. */
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp|x-icon)[;,]/i;

/** Control characters browsers ignore when resolving a URL scheme. */
const CONTROL_CHARS = /[\u0000-\u0020\u007f]/g;

/**
 * True when a URL is safe to place in an attribute.
 *
 * Allows `http:`, `https:`, `mailto:`, `tel:`, relative paths, fragments and
 * `data:image/...` for raster formats. Everything else is rejected, including
 * SVG data URIs which can carry script.
 */
export function isSafeUrl(url: string): boolean {
  const cleaned = url.replace(CONTROL_CHARS, "").trim();
  if (cleaned === "") return true;
  if (SAFE_DATA_IMAGE.test(cleaned)) return true;

  const lower = cleaned.toLowerCase();
  for (const prefix of DANGEROUS_SCHEME_PREFIXES) {
    if (lower.startsWith(prefix)) return false;
  }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(lower);
  if (schemeMatch) return ALLOWED_SCHEMES.has(schemeMatch[1] ?? "");
  return true;
}

/** `@import`, `expression()` and script URLs are stripped before compiling. */
const CSS_UNSAFE_PATTERNS: Array<[RegExp, string]> = [
  [/@import[^;]*;?/gi, ""],
  [/@charset[^;]*;?/gi, ""],
  [/expression\s*\(/gi, "void("],
  [/url\s*\(\s*(['"]?)\s*(javascript|vbscript|livescript)\s*:[^)]*\)/gi, "url(about:blank)"],
  [/-moz-binding\s*:[^;}]*/gi, ""],
  [/behavior\s*:[^;}]*/gi, ""],
];

/**
 * Strip constructs that could load or execute code from a stylesheet.
 *
 * The stylesheet compiler only understands geometry and colour declarations,
 * but a leftover `url()` in an unsupported property would still be copied into
 * the output, so anything executable is removed here.
 */
export function sanitizeCss(css: string): string {
  let out = css;
  for (const [pattern, replacement] of CSS_UNSAFE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function isAllowedAttribute(tagName: string, name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith("on")) return false;
  if (lower === "srcset") return false;
  if (DATA_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  if (ALLOWED_DATA_ATTRIBUTES.has(lower)) return true;
  if (GLOBAL_ATTRS.has(lower)) return true;
  return (TAG_ATTRS[tagName] ?? []).includes(lower);
}

function filterAttributes(el: DomElement, diagnostics: Diagnostic[]): void {
  const kept: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(el.attributes)) {
    const name = rawName.toLowerCase();
    if (!isAllowedAttribute(el.tagName, name)) {
      if (name.startsWith("on")) {
        diagnostics.push({
          level: "warning",
          stage: "sanitize",
          property: name,
          element: el.tagName,
          message: `Event handler attribute "${name}" was removed`,
        });
      }
      continue;
    }
    if (URL_ATTRS.has(name) && !isSafeUrl(value)) {
      diagnostics.push({
        level: "warning",
        stage: "sanitize",
        property: name,
        element: el.tagName,
        message: `Unsafe URL in "${name}" was removed`,
      });
      continue;
    }
    kept[name] = value;
  }
  el.attributes = kept;
}

/**
 * Rebuild a node's subtree in place, keeping only whitelisted tags.
 *
 * Forbidden tags lose their whole subtree. Unknown-but-harmless tags are
 * unwrapped: their children are spliced into the parent so content survives.
 * `<style>` elements are not walked at all; their text is hoisted separately.
 */
function sanitizeChildren(
  children: DomNode[],
  diagnostics: Diagnostic[],
  hoistedCss: string[],
): DomNode[] {
  const sink: DomNode[] = [];
  for (const node of children) {
    if (node.kind === "text") {
      sink.push(node);
      continue;
    }
    if (node.kind === "comment") continue;

    if (FORBIDDEN_TAGS.has(node.tagName)) {
      diagnostics.push({
        level: "warning",
        stage: "sanitize",
        element: node.tagName,
        message: `<${node.tagName}> is not supported and was removed`,
      });
      continue;
    }

    if (STYLE_TAGS.has(node.tagName)) {
      const css = textContentOf(node).trim();
      if (css !== "") hoistedCss.push(sanitizeCss(css));
      continue;
    }

    filterAttributes(node, diagnostics);
    if (node.attributes.hidden !== undefined) continue;

    if (!ALLOWED_TAGS.has(node.tagName)) {
      diagnostics.push({
        level: "info",
        stage: "sanitize",
        element: node.tagName,
        message: `Unknown element <${node.tagName}> was unwrapped`,
      });
      sink.push(...sanitizeChildren(node.children, diagnostics, hoistedCss));
      continue;
    }

    node.children = sanitizeChildren(node.children, diagnostics, hoistedCss);
    for (const child of node.children) child.parent = node;
    sink.push(node);
  }
  return sink;
}

/** Concatenated text of a subtree, used to read `<style>` bodies. */
function textContentOf(node: DomElement): string {
  let out = "";
  for (const child of node.children) {
    if (child.kind === "text") out += child.value;
    else if (child.kind === "element") out += textContentOf(child);
  }
  return out;
}

/** Sanitize an already-built tree in place. Exposed for tests and reuse. */
export function sanitizeTree(
  root: DomElement,
  diagnostics: Diagnostic[] = [],
): DomElement {
  const hoistedCss: string[] = [];
  root.children = sanitizeChildren(root.children, diagnostics, hoistedCss);
  for (const child of root.children) child.parent = root;
  return root;
}

/** Synthetic root tag; `<section data-slide>` descendants become slides. */
const ROOT_TAG = "div";

/**
 * Parse and sanitize a raw HTML string into a {@link DomElement} tree.
 *
 * The returned root is a synthetic `<div>`; look for `<section data-slide>`
 * descendants to build slides, and treat the root itself as a single slide
 * when none exist. Any `<style>` bodies are hoisted into `css` instead of
 * staying in the tree, so they never reach layout.
 */
export function parseHtml(html: string): {
  root: DomElement;
  css: string;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const rawNodes = parseFragment(html ?? "");
  const root = createElement(ROOT_TAG, {}, []);
  const hoistedCss: string[] = [];
  const children = sanitizeChildren(rawNodes, diagnostics, hoistedCss);
  root.children = children;
  for (const child of children) child.parent = root;

  if (!children.some((child) => isElement(child))) {
    diagnostics.push({
      level: "warning",
      stage: "parse",
      message: "Input contained no element nodes; the slide will be empty",
    });
  }
  return { root, css: hoistedCss.join("\n"), diagnostics };
}

/** Convenience: parse and immediately collect all elements depth-first. */
export function parseHtmlElements(html: string): DomElement[] {
  const { root } = parseHtml(html);
  const out: DomElement[] = [];
  const visit = (el: DomElement): void => {
    out.push(el);
    for (const child of el.children) if (isElement(child)) visit(child);
  };
  visit(root);
  return out;
}

interface Parse5Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  data?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Parse5Node[];
}

/**
 * Parse a fragment of HTML with parse5.
 *
 * `parseFragment` rather than `parse`, so a snippet does not get wrapped in a
 * synthetic `<html>/<head>/<body>` skeleton that would otherwise show up as
 * unknown elements in the diagnostics.
 */
function parseFragment(html: string): DomNode[] {
  const fragment = parse5Fragment(html) as unknown as Parse5Node;
  const out: DomNode[] = [];
  for (const child of fragment.childNodes ?? []) {
    const converted = convertNode(child);
    if (converted) out.push(converted);
  }
  return out;
}

function convertNode(raw: Parse5Node): DomNode | null {
  if (raw.nodeName === "#text") return createText(raw.value ?? "");
  if (raw.nodeName === "#comment") {
    return { kind: "comment", value: raw.data ?? "", parent: null };
  }
  if (raw.nodeName === "#documentType" || !raw.tagName) return null;

  const attributes: Record<string, string> = {};
  for (const attr of raw.attrs ?? []) {
    attributes[attr.name.toLowerCase()] = attr.value;
  }
  const children: DomNode[] = [];
  for (const child of raw.childNodes ?? []) {
    const converted = convertNode(child);
    if (converted) children.push(converted);
  }
  return createElement(raw.tagName, attributes, children, raw.tagName);
}