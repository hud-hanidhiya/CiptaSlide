import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { PptxStructureError } from "../errors";

/**
 * QA struktural file .pptx (docs/00-guardrails.md):
 * "tidak ada exception saat render" BUKAN bukti file valid — file wajib dibuka ulang
 * sebagai ZIP dan dicek entri XML intinya sebelum dilaporkan sukses ke chat.
 *
 * Return: daftar masalah (kosong = valid). Throw PptxStructureError kalau dilewatkan opsi strict.
 */

export interface PptxValidationResult {
  valid: boolean;
  problems: string[];
}

const REQUIRED_ENTRIES = [
  "[Content_Types].xml",
  "_rels/.rels",
  "ppt/presentation.xml",
] as const;

export async function validatePptxStructure(path: string): Promise<string[]> {
  const problems: string[] = [];

  let zip: JSZip;
  try {
    const data = await readFile(path);
    zip = await JSZip.loadAsync(data); // ZIP corrupt → throw di sini, tertangkap jadi problem
  } catch (err) {
    return [
      `File tidak bisa dibuka sebagai ZIP/OOXML: ${err instanceof Error ? err.message : String(err)}`,
    ];
  }

  for (const entry of REQUIRED_ENTRIES) {
    if (!zip.file(entry)) {
      problems.push(`Entri wajib hilang: ${entry}`);
    }
  }

  const slideFiles = Object.keys(zip.files).filter(
    (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)
  );
  if (slideFiles.length === 0) {
    problems.push("Tidak ada satu pun ppt/slides/slideN.xml — deck tanpa slide.");
  }

  if (zip.file("ppt/presentation.xml")) {
    const presentationXml = await zip.file("ppt/presentation.xml")!.async("string");
    if (!presentationXml.includes("<p:sldIdLst") && !presentationXml.includes("sldIdLst")) {
      problems.push("ppt/presentation.xml tidak memuat daftar slide (sldIdLst).");
    }
  }

  const contentTypes = zip.file("[Content_Types].xml");
  if (contentTypes) {
    const xml = await contentTypes.async("string");
    for (const required of ["presentation.main+xml", "slide+xml"]) {
      if (!xml.includes(required)) {
        problems.push(`[Content_Types].xml tidak mendeklarasikan tipe '${required}'.`);
      }
    }
  }

  return problems;
}

/** Varian fail-loud untuk pipeline: throw PptxStructureError dengan daftar masalah. */
export async function assertValidPptxStructure(path: string): Promise<PptxValidationResult> {
  const problems = await validatePptxStructure(path);
  if (problems.length > 0) {
    throw new PptxStructureError(problems);
  }
  return { valid: true, problems };
}
