/**
 * `data-pptx-*` attribute support (PRD sections 28-29).
 *
 * This is the escape hatch that lets an author override the layout engine
 * without fighting it. Values are read as inches because that is how slide
 * geometry is expressed in PowerPoint, and inches are what slide authors think
 * in. Nothing here invents new layout concepts: overrides are applied as if the
 * author had written matching `position`/`width`/`height` CSS.
 *
 * Recognised attributes:
 *
 * | Attribute | Meaning |
 * |---|---|
 * | `data-pptx-ignore` | Skip the element and its subtree entirely |
 * | `data-pptx-x` / `data-pptx-y` | Absolute position, in inches |
 * | `data-pptx-width` / `data-pptx-height` | Size, in inches |
 * | `data-pptx-font-size` | Font size, in points |
 * | `data-pptx-font-family` | Font family name |
 * | `data-pptx-font-weight` | `bold`, `normal` or a numeric weight |
 * | `data-pptx-color` | Text colour, any CSS colour syntax |
 * | `data-pptx-background` | Fill colour, any CSS colour syntax |
 * | `data-pptx-align` | `left`, `center`, `right`, `justify` |
 * | `data-pptx-type` | Force the slide element type: `text`, `image`, `shape`, `line` |
 * | `data-pptx-shape` | pptxgenjs preset shape name, e.g. `roundRect`, `ellipse` |
 * | `data-pptx-as-image` | Render the subtree as one flattened image |
 * | `data-pptx-bullet` | Force a bullet glyph, or `none` |
 * | `data-pptx-rotate` | Rotation in degrees |
 */

/** Geometry and style overrides read from `data-pptx-*`. */
export interface PptxOverrides {
  /** Skip this element and its subtree. */
  ignore: boolean;
  /** Absolute position in inches. */
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  /** Font size in points. */
  fontSizePt: number | null;
  fontFamily: string | null;
  fontWeight: string | null;
  color: string | null;
  background: string | null;
  align: "left" | "center" | "right" | "justify" | null;
  type: "text" | "image" | "shape" | "line" | null;
  shape: string | null;
  /** Force the subtree to be flattened into a single image. */
  asImage: boolean;
  /** Bullet glyph, or the literal string `none` to suppress a marker. */
  bullet: string | null;
  /** True when `data-pptx-bullet="none"` was set. */
  bulletDisabled: boolean;
  rotate: number | null;
}

/** Attribute that forces rasterisation of a subtree. */
const AS_IMAGE_ATTR = "data-pptx-as-image";

/** True when the attribute is present and not explicitly set to `false`. */
function flagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "false" && normalized !== "0" && normalized !== "no";
}

/** Parse a number attribute, returning null for absent or malformed values. */
function numberAttr(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Read every `data-pptx-*` override from an element. */
export function readOverrides(attributes: Record<string, string>): PptxOverrides {
  const bullet = attributes["data-pptx-bullet"];
  const type = attributes["data-pptx-type"];
  const align = attributes["data-pptx-align"];
  const shape = attributes["data-pptx-shape"];

  const validAlign =
    align !== undefined &&
    (align === "left" || align === "center" || align === "right" || align === "justify")
      ? align
      : null;

  const validType =
    type !== undefined &&
    (type === "text" || type === "image" || type === "shape" || type === "line")
      ? type
      : null;

  return {
    ignore: flagEnabled(attributes["data-pptx-ignore"]),
    x: numberAttr(attributes["data-pptx-x"]),
    y: numberAttr(attributes["data-pptx-y"]),
    width: numberAttr(attributes["data-pptx-width"]),
    height: numberAttr(attributes["data-pptx-height"]),
    fontSizePt: numberAttr(attributes["data-pptx-font-size"]),
    fontFamily: attributes["data-pptx-font-family"] ?? null,
    fontWeight: attributes["data-pptx-font-weight"] ?? null,
    color: attributes["data-pptx-color"] ?? null,
    background: attributes["data-pptx-background"] ?? null,
    align: validAlign,
    type: validType,
    shape: shape !== undefined && shape.trim() !== "" ? shape.trim() : null,
    asImage: flagEnabled(attributes[AS_IMAGE_ATTR]),
    bullet: bullet !== undefined && bullet !== "none" ? bullet : null,
    bulletDisabled: bullet === "none",
    rotate: numberAttr(attributes["data-pptx-rotate"]),
  };
}

/** True when no override is set, so the mapper can skip the whole path. */
export function hasNoOverrides(overrides: PptxOverrides): boolean {
  return (
    !overrides.ignore &&
    overrides.x === null &&
    overrides.y === null &&
    overrides.width === null &&
    overrides.height === null &&
    overrides.fontSizePt === null &&
    overrides.fontFamily === null &&
    overrides.fontWeight === null &&
    overrides.color === null &&
    overrides.background === null &&
    overrides.align === null &&
    overrides.type === null &&
    overrides.shape === null &&
    !overrides.asImage &&
    overrides.bullet === null &&
    !overrides.bulletDisabled &&
    overrides.rotate === null
  );
}