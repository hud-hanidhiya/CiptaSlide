/**
 * Asset resolution: turn `<img src>` values into inline data URIs.
 *
 * The PPTX writer never performs I/O. Everything an image element needs is
 * resolved during conversion, so rendering a presentation is pure computation
 * and therefore deterministic in tests.
 *
 * Supported sources, in priority order:
 *
 * 1. `data:image/...` — used verbatim.
 * 2. A key in the caller's asset map (uploaded ZIP, or client-provided blobs).
 * 3. `http:`/`https:` — downloaded once, with a size cap and a timeout.
 *
 * Anything else yields null, and the mapper records a warning so the user learns
 * why their image is missing rather than getting a silent blank.
 */

import type { Diagnostic } from "../shared/ir";

/** A resolved image, ready to embed. */
export interface ResolvedAsset {
  /** `data:<mime>;base64,<payload>`. */
  dataUri: string;
  /** Intrinsic width in px, or 0 when unknown. */
  widthPx: number;
  /** Intrinsic height in px, or 0 when unknown. */
  heightPx: number;
  /** Original MIME type. */
  mimeType: string;
}

/** Options for {@link AssetResolver}. */
export interface AssetResolverOptions {
  /** Pre-registered assets keyed by their reference as written in HTML. */
  assets?: Record<string, ResolvedAsset>;
  /** Allow outbound HTTP requests. Off by default: SSRF risk. */
  allowRemote?: boolean;
  /** Hard cap on a downloaded image, in bytes. Default 5 MiB. */
  maxRemoteBytes?: number;
  /** Request timeout in milliseconds. Default 5000. */
  timeoutMs?: number;
  /** Injected fetch implementation, for tests. */
  fetchImpl?: typeof fetch;
}

/** Result of resolving one reference. */
export interface AssetResolution {
  asset: ResolvedAsset | null;
  diagnostics: Diagnostic[];
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

/** Matches a `data:` URI with an explicit MIME type. */
const DATA_URI = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?(;[^,]*)?,(.*)$/is;

/**
 * Read intrinsic pixel dimensions out of common raster formats.
 *
 * Only the header is parsed, so this stays cheap and allocation-free. Formats
 * we cannot size report 0x0, and the mapper falls back to the layout box.
 */
export function imageSizeFromBytes(bytes: Uint8Array, mimeType: string): { widthPx: number; heightPx: number } {
  try {
    switch (mimeType) {
      case "image/png":
        return readPngSize(bytes);
      case "image/gif":
        return readGifSize(bytes);
      case "image/jpeg":
      case "image/jpg":
        return readJpegSize(bytes);
      case "image/bmp":
        return readBmpSize(bytes);
      case "image/webp":
        return readWebpSize(bytes);
      default:
        return { widthPx: 0, heightPx: 0 };
    }
  } catch {
    return { widthPx: 0, heightPx: 0 };
  }
}

function readPngSize(bytes: Uint8Array): { widthPx: number; heightPx: number } {
  // IHDR is always the first chunk: 8-byte signature, 4-byte length, "IHDR".
  if (bytes.length < 24) return { widthPx: 0, heightPx: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { widthPx: view.getUint32(16, false), heightPx: view.getUint32(20, false) };
}

function readGifSize(bytes: Uint8Array): { widthPx: number; heightPx: number } {
  if (bytes.length < 10) return { widthPx: 0, heightPx: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { widthPx: view.getUint16(6, true), heightPx: view.getUint16(8, true) };
}

function readBmpSize(bytes: Uint8Array): { widthPx: number; heightPx: number } {
  if (bytes.length < 26) return { widthPx: 0, heightPx: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { widthPx: view.getInt32(18, true), heightPx: Math.abs(view.getInt32(22, true)) };
}

function readWebpSize(bytes: Uint8Array): { widthPx: number; heightPx: number } {
  if (bytes.length < 30) return { widthPx: 0, heightPx: 0 };
  const ascii = (offset: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  const format = ascii(12, 4);
  if (format === "VP8 ") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { widthPx: view.getUint16(26, true) & 0x3fff, heightPx: view.getUint16(28, true) & 0x3fff };
  }
  if (format === "VP8L") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bits = view.getUint32(21, true);
    return { widthPx: (bits & 0x3fff) + 1, heightPx: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (format === "VP8X") {
    const width = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16));
    const height = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16));
    return { widthPx: width, heightPx: height };
  }
  return { widthPx: 0, heightPx: 0 };
}

function readJpegSize(bytes: Uint8Array): { widthPx: number; heightPx: number } {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // SOF0-SOF15 carry the frame dimensions, excluding the non-frame markers.
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { widthPx: view.getUint16(offset + 7, false), heightPx: view.getUint16(offset + 5, false) };
    }
    const segmentLength = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (segmentLength <= 0) return { widthPx: 0, heightPx: 0 };
    offset += 2 + segmentLength;
  }
  return { widthPx: 0, heightPx: 0 };
}

/** Build a `data:` URI from raw bytes. */
export function toDataUri(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Parse a `data:` URI into bytes plus MIME type. */
export function parseDataUri(uri: string): { mimeType: string; bytes: Uint8Array } | null {
  const match = DATA_URI.exec(uri);
  if (!match) return null;
  const mimeType = (match[1] ?? "text/plain").toLowerCase();
  const parameters = match[2] ?? "";
  const payload = match[3] ?? "";
  if (/;base64/i.test(parameters)) {
    return { mimeType, bytes: new Uint8Array(Buffer.from(payload, "base64")) };
  }
  return { mimeType, bytes: new Uint8Array(Buffer.from(decodeURIComponent(payload), "utf8")) };
}

/**
 * Resolve image references into embeddable assets.
 *
 * Instances are cheap and stateless apart from the cache, so one resolver can
 * serve a whole presentation.
 */
export class AssetResolver {
  private readonly cache = new Map<string, ResolvedAsset | null>();

  private readonly assets: Record<string, ResolvedAsset>;
  private readonly allowRemote: boolean;
  private readonly maxRemoteBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AssetResolverOptions = {}) {
    this.assets = options.assets ?? {};
    this.allowRemote = options.allowRemote ?? false;
    this.maxRemoteBytes = options.maxRemoteBytes ?? DEFAULT_MAX_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Resolve one `src` value. Results are cached, including negative ones. */
  async resolve(src: string, slideIndex?: number): Promise<AssetResolution> {
    const diagnostics: Diagnostic[] = [];
    const reference = src.trim();
    if (reference === "") {
      diagnostics.push({
        level: "warning",
        stage: "assets",
        property: "src",
        element: "img",
        slideIndex,
        message: "Image has an empty src and was skipped",
      });
      return { asset: null, diagnostics };
    }

    if (this.cache.has(reference)) {
      const cached = this.cache.get(reference) ?? null;
      if (cached === null) {
        diagnostics.push(this.unsupportedDiagnostic(reference, slideIndex));
      }
      return { asset: cached, diagnostics };
    }

    let asset: ResolvedAsset | null = null;

    if (reference.startsWith("data:")) {
      asset = this.fromDataUri(reference);
    } else if (this.assets[reference] !== undefined) {
      asset = this.assets[reference] ?? null;
    } else if (/^https?:\/\//i.test(reference)) {
      asset = await this.fromRemote(reference, diagnostics, slideIndex);
    }

    this.cache.set(reference, asset);
    if (asset === null) diagnostics.push(this.unsupportedDiagnostic(reference, slideIndex));
    return { asset, diagnostics };
  }

  private unsupportedDiagnostic(reference: string, slideIndex?: number): Diagnostic {
    return {
      level: "warning",
      stage: "assets",
      property: "src",
      element: "img",
      slideIndex,
      message: this.allowRemote
        ? `Image "${truncate(reference)}" could not be loaded`
        : `Image "${truncate(reference)}" is not an inline data URI and remote images are disabled`,
    };
  }

  private fromDataUri(reference: string): ResolvedAsset | null {
    const parsed = parseDataUri(reference);
    if (!parsed) return null;
    if (!parsed.mimeType.startsWith("image/")) return null;
    const size = imageSizeFromBytes(parsed.bytes, parsed.mimeType);
    return {
      dataUri: toDataUri(parsed.bytes, parsed.mimeType),
      widthPx: size.widthPx,
      heightPx: size.heightPx,
      mimeType: parsed.mimeType,
    };
  }

  private async fromRemote(
    reference: string,
    diagnostics: Diagnostic[],
    slideIndex?: number,
  ): Promise<ResolvedAsset | null> {
    if (!this.allowRemote) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(reference, { signal: controller.signal });
      if (!response.ok) {
        diagnostics.push({
          level: "warning",
          stage: "assets",
          property: "src",
          element: "img",
          slideIndex,
          message: `Image "${truncate(reference)}" returned HTTP ${response.status}`,
        });
        return null;
      }
      const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(declared) && declared > this.maxRemoteBytes) {
        diagnostics.push({
          level: "warning",
          stage: "assets",
          property: "src",
          element: "img",
          slideIndex,
          message: `Image "${truncate(reference)}" exceeds the ${this.maxRemoteBytes} byte limit`,
        });
        return null;
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > this.maxRemoteBytes) {
        diagnostics.push({
          level: "warning",
          stage: "assets",
          property: "src",
          element: "img",
          slideIndex,
          message: `Image "${truncate(reference)}" exceeds the ${this.maxRemoteBytes} byte limit`,
        });
        return null;
      }
      const mimeType = (response.headers.get("content-type") ?? "image/png")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      if (!mimeType.startsWith("image/")) return null;
      const size = imageSizeFromBytes(buffer, mimeType);
      return { dataUri: toDataUri(buffer, mimeType), widthPx: size.widthPx, heightPx: size.heightPx, mimeType };
    } catch (error) {
      diagnostics.push({
        level: "warning",
        stage: "assets",
        property: "src",
        element: "img",
        slideIndex,
        message: `Image "${truncate(reference)}" failed to download: ${errorMessage(error)}`,
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function truncate(value: string, max = 60): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build a resolver from an asset map produced by a ZIP upload.
 *
 * Keys are the paths as referenced from the HTML document, so `images/logo.png`
 * resolves when the HTML referenced `images/logo.png`.
 */
export function resolverFromAssetMap(
  assets: Record<string, { bytes: Uint8Array; mimeType: string }>,
  options: AssetResolverOptions = {},
): AssetResolver {
  const resolved: Record<string, ResolvedAsset> = {};
  for (const [key, entry] of Object.entries(assets)) {
    const size = imageSizeFromBytes(entry.bytes, entry.mimeType);
    resolved[key] = {
      dataUri: toDataUri(entry.bytes, entry.mimeType),
      widthPx: size.widthPx,
      heightPx: size.heightPx,
      mimeType: entry.mimeType,
    };
  }
  return new AssetResolver({ ...options, assets: resolved });
}