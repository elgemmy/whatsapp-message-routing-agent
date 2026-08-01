import { open } from "node:fs/promises";
import path from "node:path";

export type MediaKind = "image" | "voice";
export type MediaFamily = "image" | "audio" | "unknown";
export type MediaFormat =
  | "jpeg"
  | "png"
  | "webp"
  | "avif"
  | "mp3"
  | "wav"
  | "m4a"
  | "mp4"
  | "unknown";

export type MediaInspection = {
  mediaId: string;
  kind: MediaKind;
  relativePath: string;
  declaredFormat: MediaFormat;
  detectedFormat: MediaFormat;
  declaredFamily: MediaFamily;
  detectedFamily: MediaFamily;
  extensionMismatch: boolean;
  familyMismatch: boolean;
  readStatus: "readable" | "missing" | "unreadable";
  decodeStatus: "not_attempted";
  decodeReason: "no_decoder_configured";
};

const FORMAT_FAMILIES: Record<MediaFormat, MediaFamily> = {
  jpeg: "image",
  png: "image",
  webp: "image",
  avif: "image",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  mp4: "audio",
  unknown: "unknown",
};

export function formatFamily(format: MediaFormat): MediaFamily {
  return FORMAT_FAMILIES[format];
}

export function declaredFormatFromPath(filePath: string): MediaFormat {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "jpeg";
    case ".png":
      return "png";
    case ".webp":
      return "webp";
    case ".avif":
      return "avif";
    case ".mp3":
      return "mp3";
    case ".wav":
      return "wav";
    case ".m4a":
      return "m4a";
    case ".mp4":
      return "mp4";
    default:
      return "unknown";
  }
}

function ascii(buffer: Buffer, start: number, end: number): string {
  return buffer.subarray(start, end).toString("ascii");
}

export function detectMediaFormat(buffer: Buffer): MediaFormat {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "jpeg";
  }

  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "png";
  }

  if (buffer.length >= 12 && ascii(buffer, 0, 4) === "RIFF") {
    const riffKind = ascii(buffer, 8, 12);
    if (riffKind === "WEBP") return "webp";
    if (riffKind === "WAVE") return "wav";
  }

  if (
    buffer.length >= 3 &&
    (ascii(buffer, 0, 3) === "ID3" ||
      (buffer[0] === 0xff && ((buffer[1] ?? 0) & 0xe0) === 0xe0))
  ) {
    return "mp3";
  }

  if (buffer.length >= 12 && ascii(buffer, 4, 8) === "ftyp") {
    const brands = ascii(buffer, 8, Math.min(buffer.length, 32)).toLowerCase();
    if (brands.includes("avif") || brands.includes("avis")) return "avif";
    if (brands.includes("m4a")) return "m4a";
    return "mp4";
  }

  return "unknown";
}

export async function inspectMedia(args: {
  datasetRoot: string;
  mediaId: string;
  kind: MediaKind;
  relativePath: string;
}): Promise<MediaInspection> {
  const declaredFormat = declaredFormatFromPath(args.relativePath);
  const declaredFamily = formatFamily(declaredFormat);
  let detectedFormat: MediaFormat = "unknown";
  let readStatus: MediaInspection["readStatus"] = "readable";

  try {
    const handle = await open(path.resolve(args.datasetRoot, args.relativePath), "r");
    try {
      const header = Buffer.alloc(64);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      detectedFormat = detectMediaFormat(header.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    readStatus = code === "ENOENT" ? "missing" : "unreadable";
  }

  const detectedFamily = formatFamily(detectedFormat);
  const expectedFamily: MediaFamily = args.kind === "image" ? "image" : "audio";
  return {
    mediaId: args.mediaId,
    kind: args.kind,
    relativePath: args.relativePath,
    declaredFormat,
    detectedFormat,
    declaredFamily,
    detectedFamily,
    extensionMismatch:
      detectedFormat !== "unknown" && detectedFormat !== declaredFormat,
    familyMismatch:
      detectedFamily !== "unknown" && detectedFamily !== expectedFamily,
    readStatus,
    decodeStatus: "not_attempted",
    decodeReason: "no_decoder_configured",
  };
}
