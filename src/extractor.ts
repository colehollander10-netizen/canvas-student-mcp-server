/**
 * File content extraction for Canvas files.
 * Downloads the file as a buffer and parses text using officeparser.
 * Supports PDF, PPTX, DOCX, XLSX (and their legacy .ppt/.doc/.xls variants).
 */

import { parseOfficeAsync } from "officeparser";
import type { CanvasClient } from "./client.js";

/** Max file size to attempt downloading (10 MB). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Max characters returned per file — keeps multi-file responses under 25KB. */
export const PER_FILE_CHAR_LIMIT = 8_000;

/** MIME types we can extract text from, mapped to friendly labels. */
const SUPPORTED_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
  "application/vnd.ms-powerpoint": "PowerPoint (legacy)",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "application/msword": "Word (legacy)",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
  "application/vnd.ms-excel": "Excel (legacy)",
};

export type ExtractSuccess = {
  ok: true;
  text: string;
  truncated: boolean;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
};

export type ExtractFailure = {
  ok: false;
  reason: string;
  fileName?: string;
  fileType?: string;
  fileSizeBytes?: number;
};

export type ExtractResult = ExtractSuccess | ExtractFailure;

/**
 * Fetch a Canvas file by ID, download its bytes, and extract plain text.
 * Returns { ok: true, text } on success or { ok: false, reason } on any failure —
 * never throws, so callers (like the study materials orchestrator) can handle
 * partial failures without aborting the whole batch.
 */
export async function extractFileContent(
  client: CanvasClient,
  fileId: string | number
): Promise<ExtractResult> {
  // 1. Fetch file metadata
  let meta: Record<string, unknown>;
  try {
    meta = await client.get<Record<string, unknown>>(`/files/${fileId}`);
  } catch (err) {
    return {
      ok: false,
      reason: `Could not fetch metadata for file ${fileId}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const fileName = String(meta.display_name ?? meta.filename ?? fileId);
  const fileSizeBytes = Number(meta.size ?? 0);
  const mimeType = String(meta["content-type"] ?? "");
  const downloadUrl = String(meta.url ?? "");

  // 2. Size gate
  if (fileSizeBytes > MAX_FILE_BYTES) {
    return {
      ok: false,
      reason: `"${fileName}" is ${(fileSizeBytes / 1_048_576).toFixed(1)} MB — exceeds the 10 MB limit.`,
      fileName,
      fileSizeBytes,
    };
  }

  // 3. MIME type gate
  const friendlyType = SUPPORTED_TYPES[mimeType];
  if (!friendlyType) {
    return {
      ok: false,
      reason: `"${fileName}" has unsupported type "${mimeType || "unknown"}" — only PDF, PPTX, DOCX, and XLSX are supported.`,
      fileName,
      fileSizeBytes,
    };
  }

  if (!downloadUrl) {
    return {
      ok: false,
      reason: `"${fileName}" has no download URL — it may be locked or restricted.`,
      fileName,
      fileSizeBytes,
    };
  }

  // 4. Download
  let buffer: Buffer;
  try {
    buffer = await client.download(downloadUrl);
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to download "${fileName}": ${err instanceof Error ? err.message : String(err)}`,
      fileName,
      fileSizeBytes,
    };
  }

  // 5. Parse with officeparser
  let rawText: string;
  try {
    rawText = await parseOfficeAsync(buffer, { outputErrorToConsole: false });
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to parse "${fileName}": ${err instanceof Error ? err.message : String(err)}`,
      fileName,
      fileType: friendlyType,
      fileSizeBytes,
    };
  }

  // 6. Normalise whitespace and apply per-file character cap
  const text = rawText.replace(/\s+/g, " ").trim();
  const truncated = text.length > PER_FILE_CHAR_LIMIT;

  return {
    ok: true,
    text: truncated ? text.slice(0, PER_FILE_CHAR_LIMIT) : text,
    truncated,
    fileName,
    fileType: friendlyType,
    fileSizeBytes,
  };
}
