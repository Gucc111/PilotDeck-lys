#!/usr/bin/env node

import fs from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  injectNativeCharts,
  inspectDrawingPackage,
  inspectNativeCharts,
  pruneEmptyDrawingParts,
  workbookSheetParts,
} from "./lib/native-charts.mjs";
import {
  NUMERIC_INTEGRITY_PROTOCOL,
  SOURCE_EVIDENCE_PROTOCOL,
  evaluateNumericIntegrityPlan,
  planOutputSheets,
  planSourcePaths,
  validateNumericIntegrityPlan,
} from "./lib/numeric-integrity.mjs";
import {
  DATA_OPERATIONS,
  VALIDATION_PROFILES,
  defaultDataOperation,
  deriveTaskProfile,
} from "./lib/task-profile.mjs";
import {
  SPREADSHEET_ATTESTATION_PROTOCOL,
  compareAttestationBindings,
  validateSpreadsheetAttestation,
} from "./lib/attestation.mjs";
import { selectAdaptiveSheets, selectReviewPages } from "./lib/visual-policy.mjs";
import { PROJECT_GUARD_PROTOCOL, compareProjectGuard } from "./lib/workspace-boundary.mjs";

const execFileAsync = promisify(execFile);
const runtimeRoot = process.env.SPREADSHEET_RUNTIME_ROOT;
const skillRoot = process.env.SPREADSHEET_SKILL_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!runtimeRoot) {
  throw new Error("SPREADSHEET_RUNTIME_ROOT is not set. Run this command through scripts/spreadsheet.sh.");
}

const require = createRequire(path.join(runtimeRoot, "package.json"));
const ExcelJS = require("exceljs");
const { parse: parseDelimitedText } = require("csv-parse/sync");
const JSZip = require("jszip");
const { DOMParser } = require("@xmldom/xmldom");
const sharp = require("sharp");
const iconv = require("iconv-lite");

const NATIVE_CHART_SPECS = new WeakMap();
const INSERTED_IMAGE_SPECS = new WeakMap();
const REGISTERED_INTEGRITY_PLANS = new WeakMap();
const GUARDED_WORKBOOKS = new WeakSet();
const GUARDED_WORKSHEETS = new WeakSet();
const TABLE_RANGE_COPY_DEPTH = Symbol("pilotdeckTableRangeCopyDepth");

const RESULT_STATUSES = ["ok", "partial", "unsupported", "blocked", "error"];
const CAPABILITY_STATES = ["supported", "partial", "fallback", "unsupported", "blocked"];
const WORKBOOK_TYPES = new Set(["data", "tracker", "model", "dashboard", "report", "template"]);
const STYLE_MODES = new Set(["neutral-built-in", "preserve-source", "user-template"]);
const VISUAL_REVIEW_MODES = new Set(["adaptive", "all-pages", "selected-sheets", "structural-only"]);
const TASK_PROTOCOL = "pilotdeck-spreadsheet-task/v2";
const LEGACY_TASK_PROTOCOL = "pilotdeck-spreadsheet-task/v1";
const VISUAL_REVIEW_PROTOCOL = "pilotdeck-spreadsheet-visual-review/v2";
const LEGACY_VISUAL_REVIEW_PROTOCOL = "pilotdeck-spreadsheet-visual-review/v1";
const PROJECT_SNAPSHOT_PROTOCOL = "pilotdeck-spreadsheet-project-snapshot/v1";
const NUMERIC_INTEGRITY_STATES = new Set(["prepared", "bound"]);
const EVIDENCE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"]);

class SpreadsheetProtocolError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "SpreadsheetProtocolError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function blocked(code, message, details = {}) {
  return new SpreadsheetProtocolError("blocked", code, message, details);
}

function unsupported(code, message, details = {}) {
  return new SpreadsheetProtocolError("unsupported", code, message, details);
}

class SpreadsheetStageError extends Error {
  constructor(stage, message, cause, details = {}) {
    super(`${stage}: ${message}`, { cause });
    this.name = "SpreadsheetStageError";
    this.stage = stage;
    this.details = details;
  }
}

async function runStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SpreadsheetStageError || error instanceof SpreadsheetProtocolError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SpreadsheetStageError(stage, message, error);
  }
}

const FORMULA_ERROR_RE = /#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!|CIRC!)/i;
const SPREADSHEET_MAIN_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const HARD_RISK_FEATURES = new Set([
  "macros",
  "charts",
  "pivotTables",
  "slicers",
  "externalLinks",
  "connections",
  "queryTables",
  "drawings",
  "embeddings",
  "activeX",
  "signatures",
]);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    const value = next === undefined || next.startsWith("--") ? true : next;
    if (Object.hasOwn(options, key)) {
      options[key] = Array.isArray(options[key]) ? [...options[key], value] : [options[key], value];
    } else {
      options[key] = value;
    }
    if (value !== true) {
      index += 1;
    }
  }
  return { command, options };
}

function requireOption(options, key) {
  const value = options[key];
  if (value === undefined || value === true || value === "" || Array.isArray(value)) {
    throw new Error(`Missing required option --${key}`);
  }
  return String(value);
}

function optionValues(options, key) {
  const value = options[key];
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value])
    .filter((item) => item !== true && item !== "")
    .map(String);
}

function integerOption(options, key, fallback) {
  if (options[key] === undefined) return fallback;
  const value = Number.parseInt(String(options[key]), 10);
  if (!Number.isFinite(value) || value < 1) throw new Error(`--${key} must be a positive integer`);
  return value;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureParent(filePath) {
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
}

function pilotDeckWorkDir() {
  const configured = String(process.env.PILOTDECK_WORK_DIR ?? "").trim();
  return configured ? resolveThroughExistingAncestor(configured) : null;
}

function isInsidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveThroughExistingAncestor(filePath) {
  let current = path.resolve(filePath);
  const suffix = [];

  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }

  const canonicalBase = existsSync(current)
    ? realpathSync.native(current)
    : current;
  return path.resolve(canonicalBase, ...suffix);
}

function pathsReferToSameLocation(left, right) {
  return resolveThroughExistingAncestor(left) === resolveThroughExistingAncestor(right);
}

function assertInternalArtifactPath(filePath, purpose) {
  const resolved = resolveThroughExistingAncestor(filePath);
  const workDir = pilotDeckWorkDir();
  if (workDir && !isInsidePath(resolved, workDir)) {
    throw new Error(
      `${purpose} is an intermediate task artifact and must be under `
      + `PILOTDECK_WORK_DIR (${workDir}). Only deliver may write the final workbook outside it.`,
    );
  }
  return resolved;
}

function assertDeliveryOutputPath(filePath) {
  const resolved = resolveThroughExistingAncestor(filePath);
  const workDir = pilotDeckWorkDir();
  if (workDir && isInsidePath(resolved, workDir)) {
    throw new Error("The final spreadsheet deliverable must be outside PILOTDECK_WORK_DIR");
  }
  return resolved;
}

async function writeJson(filePath, value) {
  const target = assertInternalArtifactPath(filePath, "Spreadsheet JSON report");
  await ensureParent(target);
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function emitReport(report, outPath) {
  if (outPath) await writeJson(outPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function workbookExtension(filePath) {
  return path.extname(filePath).toLowerCase();
}

function assertSupportedInput(filePath, { legacy = false } = {}) {
  const extension = workbookExtension(filePath);
  const allowed = legacy ? [".xlsx", ".xls", ".csv", ".tsv"] : [".xlsx", ".csv", ".tsv"];
  if (!allowed.includes(extension)) {
    throw new Error(`Unsupported spreadsheet format '${extension || "(none)"}'. Use ${allowed.join(", ")}.`);
  }
  return extension;
}

function assertSupportedOutput(filePath) {
  const extension = workbookExtension(filePath);
  if (![".xlsx", ".csv", ".tsv"].includes(extension)) {
    throw new Error(`Unsupported spreadsheet output '${extension || "(none)"}'. Use .xlsx, .csv, or .tsv.`);
  }
  return extension;
}

function hasCellContent(value) {
  return value !== null && value !== undefined && value !== "";
}

function comparableCellValue(value) {
  if (value instanceof Date) return { date: value.toISOString() };
  return serializableValue(value);
}

function assertRawTableWriteIsNonDestructive(worksheet, model) {
  if (!model || typeof model !== "object" || !Array.isArray(model.columns) || !Array.isArray(model.rows)) return;
  const start = parseCellReference(String(model.ref ?? "").split(":")[0]);
  const incoming = [model.columns.map((column) => column?.name ?? null), ...model.rows];
  const conflicts = [];
  for (let rowOffset = 0; rowOffset < incoming.length; rowOffset += 1) {
    const row = Array.isArray(incoming[rowOffset]) ? incoming[rowOffset] : [];
    for (let columnOffset = 0; columnOffset < model.columns.length; columnOffset += 1) {
      const cell = worksheet.getCell(start.row + rowOffset, start.col + columnOffset);
      const existing = cell.value;
      const replacement = row[columnOffset] ?? null;
      if (!hasCellContent(existing)) continue;
      if (JSON.stringify(comparableCellValue(existing)) === JSON.stringify(comparableCellValue(replacement))) continue;
      if (conflicts.length < 8) {
        conflicts.push({ address: cell.address, existing: comparableCellValue(existing), replacement: comparableCellValue(replacement) });
      }
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `worksheet '${worksheet.name}'.addTable would overwrite populated cells (${conflicts.map((item) => item.address).join(", ")}). `
      + "When cells are already populated, use helpers.addTableFromRange(worksheet, { name, range }) instead of passing replacement rows to worksheet.addTable.",
    );
  }
}

function guardWorksheetTableWrites(worksheet) {
  if (!worksheet || GUARDED_WORKSHEETS.has(worksheet)) return worksheet;
  const originalAddTable = worksheet.addTable.bind(worksheet);
  worksheet.addTable = (model) => {
    if (!worksheet[TABLE_RANGE_COPY_DEPTH]) assertRawTableWriteIsNonDestructive(worksheet, model);
    return originalAddTable(model);
  };
  GUARDED_WORKSHEETS.add(worksheet);
  return worksheet;
}

function guardWorkbookTableWrites(workbook) {
  if (!workbook || GUARDED_WORKBOOKS.has(workbook)) return workbook;
  for (const worksheet of workbook.worksheets) guardWorksheetTableWrites(worksheet);
  const originalAddWorksheet = workbook.addWorksheet.bind(workbook);
  workbook.addWorksheet = (...args) => guardWorksheetTableWrites(originalAddWorksheet(...args));
  GUARDED_WORKBOOKS.add(workbook);
  return workbook;
}

function createWorkbook() {
  const workbook = guardWorkbookTableWrites(new ExcelJS.Workbook());
  workbook.creator = "PilotDeck";
  workbook.lastModifiedBy = "PilotDeck";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.calcProperties.forceFullCalc = true;
  return workbook;
}

function guardedExcelJsApi() {
  class GuardedWorkbook extends ExcelJS.Workbook {
    constructor(...args) {
      super(...args);
      guardWorkbookTableWrites(this);
    }
  }
  return new Proxy(ExcelJS, {
    get(target, property) {
      if (property === "Workbook") return GuardedWorkbook;
      return Reflect.get(target, property);
    },
  });
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function normalizePrefixedSpreadsheetPackage(filePath) {
  const data = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(data);
  let changed = false;

  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir || !entryName.endsWith(".xml")) continue;
    const xml = await entry.async("string");
    const namespaceMatch = xml.match(
      /xmlns:([A-Za-z_][\w.-]*)=(["'])http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main\2/,
    );
    if (!namespaceMatch) continue;

    const prefix = escapeRegularExpression(namespaceMatch[1]);
    const quote = namespaceMatch[2];
    let normalized = xml.replace(new RegExp(`(<\\/?)(?:${prefix}):`, "g"), "$1");
    const defaultNamespace = `xmlns=${quote}${SPREADSHEET_MAIN_NAMESPACE}${quote}`;
    normalized = normalized.includes(defaultNamespace)
      ? normalized.replace(namespaceMatch[0], "")
      : normalized.replace(namespaceMatch[0], defaultNamespace);

    if (normalized !== xml) {
      zip.file(entryName, normalized);
      changed = true;
    }
  }

  return changed ? zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) : null;
}

function elementsByLocalName(root, localName) {
  const matches = [];
  const elements = root.getElementsByTagName("*");
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements.item(index);
    const elementLocalName = element?.localName ?? element?.nodeName?.split(":").at(-1);
    if (elementLocalName === localName) matches.push(element);
  }
  return matches;
}

function normalizeLibreOfficeDataValidations(xml) {
  const validationPattern = /<(?:(?:[A-Za-z_][\w.-]*):)?dataValidation\b[^>]*(?:\/>|>[\s\S]*?<\/(?:(?:[A-Za-z_][\w.-]*):)?dataValidation\s*>)/gi;
  const formula2Pattern = /<(?:(?:[A-Za-z_][\w.-]*):)?formula2\b[^>]*(?:\/>|>[\s\S]*?<\/(?:(?:[A-Za-z_][\w.-]*):)?formula2\s*>)/gi;
  let normalizedCount = 0;
  const normalizedXml = xml.replace(validationPattern, (validationXml) => {
    const openingEnd = validationXml.indexOf(">");
    if (openingEnd < 0) return validationXml;
    const opening = validationXml.slice(0, openingEnd + 1);
    const type = opening.match(/\stype=(["'])([^"']+)\1/i)?.[2]?.toLowerCase();
    if (!new Set(["list", "custom"]).has(type)) return validationXml;

    const normalizedOpening = opening.replace(/\soperator=(["'])[^"']*\1/gi, "");
    const normalizedBody = validationXml.slice(openingEnd + 1).replace(formula2Pattern, "");
    const normalized = `${normalizedOpening}${normalizedBody}`;
    if (normalized !== validationXml) normalizedCount += 1;
    return normalized;
  });
  return { xml: normalizedXml, normalizedCount };
}

async function normalizeLibreOfficeRoundTripPackage(filePath) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  let normalizedValidations = 0;
  let changedParts = 0;
  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir || !/^xl\/worksheets\/sheet\d+\.xml$/i.test(entryName)) continue;
    const xml = await entry.async("string");
    const normalized = normalizeLibreOfficeDataValidations(xml);
    if (normalized.xml === xml) continue;
    zip.file(entryName, normalized.xml);
    normalizedValidations += normalized.normalizedCount;
    changedParts += 1;
  }
  const drawingCleanup = await pruneEmptyDrawingParts(zip, { DOMParser });
  if (changedParts > 0 || drawingCleanup.removed > 0) {
    await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  }
  return {
    changed: changedParts > 0 || drawingCleanup.removed > 0,
    changedParts: changedParts + drawingCleanup.removed,
    normalizedValidations,
    removedEmptyDrawings: drawingCleanup.removed,
    removedDrawingParts: drawingCleanup.parts,
  };
}

async function collectSpreadsheetCompatibilityIssues(zip) {
  const issues = [];
  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir || !/^xl\/worksheets\/sheet\d+\.xml$/i.test(entryName)) continue;
    const xml = await entry.async("string");
    const document = new DOMParser().parseFromString(xml, "application/xml");
    for (const validation of elementsByLocalName(document, "dataValidation")) {
      const type = validation.getAttribute("type")?.toLowerCase() ?? "none";
      if (!new Set(["list", "custom"]).has(type)) continue;
      const operator = validation.getAttribute("operator");
      const formula2 = elementsByLocalName(validation, "formula2")[0]?.textContent ?? null;
      if (operator === null && formula2 === null) continue;
      issues.push({
        type: "invalid_data_validation_semantics",
        part: entryName,
        range: validation.getAttribute("sqref") ?? null,
        validationType: type,
        unexpectedOperator: operator,
        unexpectedFormula2: formula2,
      });
    }
  }
  return issues;
}

function cachedFormulaResult(cellElement) {
  const children = elementsByLocalName(cellElement, "v");
  const valueElement = children[0];
  if (!valueElement) return { present: false, value: undefined };
  const text = valueElement.textContent ?? "";
  const type = cellElement.getAttribute("t")?.toLowerCase() ?? "n";
  if (type === "str" || type === "inlinestr") return { present: true, value: text };
  if (type === "b") return { present: true, value: text !== "0" };
  if (type === "e") return { present: true, value: { error: text } };
  const numeric = Number(text);
  return { present: Number.isFinite(numeric), value: numeric };
}

async function restoreFalseyFormulaResults(workbook, packageBuffer) {
  const zip = await JSZip.loadAsync(packageBuffer);
  const sheetParts = await workbookSheetParts(zip);
  let restored = 0;
  for (const [sheetName, sheetPart] of sheetParts.entries()) {
    const worksheet = workbook.getWorksheet(sheetName);
    const part = zip.file(sheetPart);
    if (!worksheet || !part) continue;
    const document = new DOMParser().parseFromString(await part.async("string"), "application/xml");
    for (const cellElement of elementsByLocalName(document, "c")) {
      const address = cellElement.getAttribute("r");
      if (!address || elementsByLocalName(cellElement, "f").length === 0) continue;
      const cell = worksheet.getCell(address);
      const formula = formulaDescriptor(cell);
      if (!formula || formula.result !== null) continue;
      const cached = cachedFormulaResult(cellElement);
      if (!cached.present) continue;
      cell.value = { ...cell.value, result: cached.value };
      restored += 1;
    }
  }
  return restored;
}

async function loadXlsx(filePath) {
  const source = await fs.readFile(path.resolve(filePath));
  const workbook = new ExcelJS.Workbook();
  let packageBuffer = source;
  try {
    await workbook.xlsx.load(source);
  } catch (error) {
    const normalizedPackage = await normalizePrefixedSpreadsheetPackage(filePath);
    if (!normalizedPackage) throw error;
    const normalizedWorkbook = new ExcelJS.Workbook();
    await normalizedWorkbook.xlsx.load(normalizedPackage);
    packageBuffer = normalizedPackage;
    await restoreFalseyFormulaResults(normalizedWorkbook, packageBuffer);
    return guardWorkbookTableWrites(normalizedWorkbook);
  }
  await restoreFalseyFormulaResults(workbook, packageBuffer);
  return guardWorkbookTableWrites(workbook);
}

function normalizeEncoding(value) {
  const encoding = String(value ?? "auto").toLowerCase().replaceAll("_", "-");
  if (["auto", "utf8", "utf-8", "utf8-bom", "utf-8-bom", "gbk", "gb18030"].includes(encoding)) return encoding;
  throw new Error(`Unsupported text encoding '${value}'. Use auto, utf8, utf8-bom, gbk, or gb18030.`);
}

function decodeDelimitedBuffer(buffer, requestedEncoding = "auto") {
  const requested = normalizeEncoding(requestedEncoding);
  const hasUtf8Bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  let encoding = requested;
  if (encoding === "auto") {
    if (hasUtf8Bom) {
      encoding = "utf8-bom";
    } else {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        encoding = "utf8";
      } catch {
        encoding = "gb18030";
      }
    }
  }
  const withoutBom = hasUtf8Bom ? buffer.subarray(3) : buffer;
  if (["utf8", "utf-8", "utf8-bom", "utf-8-bom"].includes(encoding)) {
    return { text: withoutBom.toString("utf8"), encoding: hasUtf8Bom || encoding.includes("bom") ? "utf8-bom" : "utf8" };
  }
  return { text: iconv.decode(buffer, encoding === "gbk" ? "gbk" : "gb18030"), encoding };
}

function encodeDelimitedText(text, requestedEncoding = "utf8-bom") {
  const encoding = normalizeEncoding(requestedEncoding);
  if (encoding === "auto") throw new Error("Output encoding cannot be auto");
  if (encoding === "utf8-bom" || encoding === "utf-8-bom") return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
  if (encoding === "utf8" || encoding === "utf-8") return Buffer.from(text, "utf8");
  return iconv.encode(text, encoding === "gbk" ? "gbk" : "gb18030");
}

function inferScalar(value) {
  if (value === "") return "";
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^[+-]?0\d+$/.test(value)) return value;
  if (/^[+-]?\d{16,}$/.test(value)) return value;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return value;
}

async function loadDelimited(filePath, { sheetName = "Sheet1", inferTypes = false, encoding = "auto" } = {}) {
  const extension = assertSupportedInput(filePath);
  if (extension === ".xlsx") throw new Error("loadDelimited only accepts .csv or .tsv files");
  const delimiter = extension === ".tsv" ? "\t" : ",";
  const decoded = decodeDelimitedBuffer(await fs.readFile(filePath), encoding);
  const rows = parseDelimitedText(decoded.text, {
    bom: true,
    delimiter,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
  });
  const workbook = createWorkbook();
  const worksheet = workbook.addWorksheet(sheetName);
  for (const row of rows) {
    worksheet.addRow(inferTypes ? row.map((value) => inferScalar(value)) : row);
  }
  return workbook;
}

async function loadWorkbook(filePath, options = {}) {
  const extension = assertSupportedInput(filePath);
  return extension === ".xlsx" ? loadXlsx(filePath) : loadDelimited(filePath, options);
}

function columnNumber(letters) {
  let value = 0;
  for (const character of letters.toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64;
  return value;
}

function columnLetters(number) {
  let current = number;
  let result = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

function parseCellReference(reference) {
  const match = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(reference.trim());
  if (!match) throw new Error(`Invalid cell reference '${reference}'`);
  return { col: columnNumber(match[1]), row: Number.parseInt(match[2], 10) };
}

function parseRangeReference(reference) {
  const [fromText, toText = fromText] = reference.split(":");
  const from = parseCellReference(fromText);
  const to = parseCellReference(toText);
  return {
    startRow: Math.min(from.row, to.row),
    endRow: Math.max(from.row, to.row),
    startCol: Math.min(from.col, to.col),
    endCol: Math.max(from.col, to.col),
  };
}

function forEachCellInRange(worksheet, rangeRef, callback) {
  const bounds = parseRangeReference(rangeRef);
  for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
    for (let col = bounds.startCol; col <= bounds.endCol; col += 1) {
      callback(worksheet.getCell(row, col), row, col);
    }
  }
}

function cloneCellStyle(style = {}) {
  return structuredClone(style);
}

function applyStyle(worksheet, rangeRef, style) {
  forEachCellInRange(worksheet, rangeRef, (cell) => {
    cell.style = cloneCellStyle({ ...(cell.style ?? {}), ...style });
  });
}

function setNumberFormat(worksheet, rangeRef, numberFormat) {
  forEachCellInRange(worksheet, rangeRef, (cell) => {
    cell.numFmt = String(numberFormat);
  });
}

function addTableFromRange(worksheet, { name, range, style = { theme: "TableStyleLight1", showRowStripes: true } }) {
  if (!name || !range) throw new Error("addTableFromRange requires name and range");
  const bounds = parseRangeReference(range);
  if (bounds.endRow <= bounds.startRow) throw new Error(`Table range '${range}' must contain a header row and at least one data row`);
  const columns = [];
  const seen = new Set();
  for (let column = bounds.startCol; column <= bounds.endCol; column += 1) {
    const header = displayCellText(worksheet.getCell(bounds.startRow, column)).trim();
    if (!header) throw new Error(`Table '${name}' has an empty header at ${columnLetters(column)}${bounds.startRow}`);
    if (seen.has(header)) throw new Error(`Table '${name}' has duplicate header '${header}'`);
    seen.add(header);
    columns.push({ name: header });
  }
  const rows = [];
  for (let row = bounds.startRow + 1; row <= bounds.endRow; row += 1) {
    const values = [];
    for (let column = bounds.startCol; column <= bounds.endCol; column += 1) values.push(worksheet.getCell(row, column).value);
    rows.push(values);
  }
  worksheet[TABLE_RANGE_COPY_DEPTH] = (worksheet[TABLE_RANGE_COPY_DEPTH] ?? 0) + 1;
  try {
    return worksheet.addTable({
      name: String(name),
      ref: `${columnLetters(bounds.startCol)}${bounds.startRow}`,
      headerRow: true,
      totalsRow: false,
      style: cloneCellStyle(style),
      columns,
      rows,
    });
  } finally {
    worksheet[TABLE_RANGE_COPY_DEPTH] -= 1;
  }
}

function addListValidation(worksheet, rangeRef, values, options = {}) {
  const formula = Array.isArray(values)
    ? `"${values.map((value) => String(value).replaceAll('"', '""')).join(",")}"`
    : String(values);
  if (!formula || formula === '""') throw new Error("addListValidation requires at least one allowed value or a range formula");
  if (Array.isArray(values) && formula.length > 255) {
    throw new Error("Inline list validation exceeds Excel's 255-character limit; place the values in cells and pass a range formula instead");
  }
  forEachCellInRange(worksheet, rangeRef, (cell) => {
    cell.dataValidation = {
      type: "list",
      allowBlank: options.allowBlank ?? true,
      showErrorMessage: options.showErrorMessage ?? true,
      errorStyle: options.errorStyle ?? "stop",
      errorTitle: options.errorTitle ?? "输入无效",
      error: options.error ?? "请选择列表中的值",
      formulae: [formula],
    };
  });
}

function validateConditionalFormattingRule(rule, location) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    throw new Error(`${location} must be an object`);
  }
  if (Object.hasOwn(rule, "formula") && !Object.hasOwn(rule, "formulae")) {
    throw new Error(`${location}.formula is invalid; use ${location}.formulae as an array`);
  }
  if (["expression", "cellIs"].includes(rule.type) && (!Array.isArray(rule.formulae) || rule.formulae.length === 0)) {
    throw new Error(`${location}.formulae must be a non-empty array for conditional-formatting type '${rule.type}'`);
  }
}

function validateConditionalFormattingEntry(entry, location) {
  if (!entry?.ref) throw new Error(`${location}.ref is required`);
  if (!Array.isArray(entry.rules) || entry.rules.length === 0) {
    throw new Error(`${location}.rules must contain at least one rule`);
  }
  entry.rules.forEach((rule, index) => validateConditionalFormattingRule(rule, `${location}.rules[${index}]`));
}

function addConditionalFormatting(worksheet, { range, rules }) {
  if (!range || !Array.isArray(rules) || rules.length === 0) {
    throw new Error("addConditionalFormatting requires range and at least one rule");
  }
  validateConditionalFormattingEntry({ ref: range, rules }, `worksheet '${worksheet.name}' conditionalFormatting '${range}'`);
  worksheet.addConditionalFormatting({ ref: range, rules: structuredClone(rules) });
}

function styleHeader(worksheet, rangeRef, options = {}) {
  const fill = options.fill ?? "FFF3F4F6";
  const color = options.color ?? "FF1F2937";
  forEachCellInRange(worksheet, rangeRef, (cell) => {
    cell.style = cloneCellStyle({
      ...(cell.style ?? {}),
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: fill } },
      font: { ...(cell.font ?? {}), bold: true, color: { argb: color } },
      border: {
        ...(cell.border ?? {}),
        bottom: options.bottomBorder ?? { style: "thin", color: { argb: "FFD1D5DB" } },
      },
      alignment: { ...(cell.alignment ?? {}), vertical: "middle", horizontal: options.horizontal ?? "left" },
    });
  });
}

async function addImage(workbook, spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("addImage requires an options object");
  const worksheet = workbook.getWorksheet(spec.sheet);
  if (!worksheet) throw new Error(`addImage references missing worksheet '${spec.sheet ?? ""}'`);
  const sourcePath = path.resolve(String(spec.path ?? ""));
  if (!sourcePath || !(await pathExists(sourcePath))) throw new Error(`Image not found: ${sourcePath || "(empty path)"}`);
  const sourceExtension = path.extname(sourcePath).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"].includes(sourceExtension)) {
    throw new Error("addImage supports local PNG, JPEG, WebP, and TIFF raster images");
  }
  const from = String(spec.anchor?.from ?? "").trim();
  const to = String(spec.anchor?.to ?? "").trim();
  if (!from || !to) throw new Error("addImage requires anchor.from and anchor.to cell references");
  const fromCell = parseCellReference(from);
  const toCell = parseCellReference(to);
  if (toCell.row <= fromCell.row || toCell.col <= fromCell.col) {
    throw new Error("addImage anchor.to must be below and to the right of anchor.from");
  }

  const image = sharp(sourcePath, { failOn: "error" }).rotate();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error("Image dimensions could not be determined");
  const stats = await image.stats();
  const alpha = stats.channels[3];
  const visibleChannels = stats.channels.slice(0, 3);
  const blankTransparent = alpha && alpha.max === 0;
  const blankWhite = stats.entropy < 0.0001 && visibleChannels.length >= 3 && visibleChannels.every((channel) => channel.min >= 250);
  if (blankTransparent || blankWhite) throw new Error("Refusing to insert a blank image");

  const buffer = await image.flatten({ background: "#ffffff" }).png().toBuffer();
  const imageId = workbook.addImage({ buffer, extension: "png" });
  worksheet.addImage(imageId, `${from}:${to}`);
  const current = INSERTED_IMAGE_SPECS.get(workbook) ?? [];
  const record = {
    sheet: worksheet.name,
    source: sourcePath,
    sourceSha256: await fileSha256(sourcePath),
    sourceWidth: metadata.width,
    sourceHeight: metadata.height,
    anchor: { from, to },
  };
  current.push(record);
  INSERTED_IMAGE_SPECS.set(workbook, current);
  return structuredClone(record);
}

function isValidDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function safeDateIso(value) {
  return isValidDate(value) ? value.toISOString() : null;
}

function displayCellText(cell) {
  let renderedText;
  try {
    renderedText = cell.text;
  } catch {
    renderedText = undefined;
  }
  if (renderedText !== undefined && renderedText !== null && renderedText !== "") return String(renderedText);
  const formula = formulaDescriptor(cell);
  if (formula) {
    const result = rawFormulaResult(cell);
    if (result instanceof Date) return safeDateIso(result)?.slice(0, 10) ?? "<Invalid Date>";
    return result === null || result === undefined ? "" : String(result);
  }
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return safeDateIso(value)?.slice(0, 10) ?? "<Invalid Date>";
  if (typeof value === "object") {
    if ("result" in value) {
      if (value.result instanceof Date) return safeDateIso(value.result)?.slice(0, 10) ?? "<Invalid Date>";
      return value.result === null || value.result === undefined ? "" : String(value.result);
    }
    if ("text" in value) return String(value.text);
    if ("error" in value) return String(value.error);
    return "";
  }
  return String(value);
}

function visualTextWidth(value) {
  let width = 0;
  for (const character of String(value ?? "")) {
    const code = character.codePointAt(0);
    if (/\p{Mark}/u.test(character)) continue;
    if (
      (code >= 0x1100 && code <= 0x11ff)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe6f)
      || (code >= 0xff01 && code <= 0xff60)
      || (code >= 0x20000 && code <= 0x3ffff)
    ) width += 2;
    else width += 1;
  }
  return width;
}

function autoFitColumns(worksheet, { min = 8, max = 40, padding = 2, sampleRows = 5000 } = {}) {
  const lastColumn = Math.max(worksheet.columnCount, worksheet.actualColumnCount, 1);
  const lastRow = Math.min(Math.max(worksheet.rowCount, worksheet.actualRowCount, 1), sampleRows);
  for (let col = 1; col <= lastColumn; col += 1) {
    let width = min;
    for (let row = 1; row <= lastRow; row += 1) {
      const text = displayCellText(worksheet.getCell(row, col));
      const longestLine = text.split(/\r?\n/).reduce((longest, line) => Math.max(longest, visualTextWidth(line)), 0);
      width = Math.max(width, Math.min(max, longestLine + padding));
    }
    worksheet.getColumn(col).width = Math.max(min, Math.min(max, width));
  }
}

function fontProfile(platform = "cross-platform") {
  const normalized = String(platform).toLowerCase();
  if (["windows", "win"].includes(normalized)) return { platform: "windows", body: "Microsoft YaHei", title: "Microsoft YaHei" };
  if (["mac", "macos", "darwin"].includes(normalized)) return { platform: "macos", body: "PingFang SC", title: "PingFang SC" };
  if (["linux", "libreoffice", "server"].includes(normalized)) return { platform: "linux", body: "Noto Sans CJK SC", title: "Noto Sans CJK SC" };
  if (["cross-platform", "crossplatform", "auto"].includes(normalized)) return { platform: "cross-platform", body: null, title: null };
  throw new Error(`Unsupported font platform '${platform}'`);
}

function applyChineseTypography(worksheet, { platform = "cross-platform", bodySize = 10.5, titleSize = 16, titleRanges = [] } = {}) {
  const profile = fontProfile(platform);
  const titleCells = new Set();
  for (const range of titleRanges) forEachCellInRange(worksheet, range, (cell) => titleCells.add(cell.address));
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const isTitle = titleCells.has(cell.address);
      const current = cell.font ?? {};
      const next = { ...current, size: current.size ?? (isTitle ? titleSize : bodySize) };
      const selectedFont = isTitle ? profile.title : profile.body;
      if (selectedFont && !current.name) next.name = selectedFont;
      if (isTitle) next.bold = true;
      cell.font = next;
    });
  });
  return profile;
}

const CJK_TEXT_PATTERN = /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u;
const LATIN_ONLY_CJK_FONTS = new Set(["arial", "calibri", "aptos", "times new roman", "linux libertine g", "courier new"]);

function preferredCjkFontName() {
  if (process.platform === "win32") return "Microsoft YaHei";
  if (process.platform === "darwin") return "PingFang SC";
  return "Noto Sans CJK SC";
}

function normalizeCjkTypography(workbook, requirements) {
  if (requirements?.task?.styleMode !== "neutral-built-in") {
    return { status: "not_applied", reason: "style-policy-preserves-source-or-template", cells: 0, samples: [] };
  }
  const selectedFont = preferredCjkFontName();
  const samples = [];
  let cells = 0;
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (!CJK_TEXT_PATTERN.test(displayCellText(cell))) return;
        const current = cell.font ?? {};
        const currentName = typeof current.name === "string" ? current.name.trim() : "";
        if (currentName && !LATIN_ONLY_CJK_FONTS.has(currentName.toLowerCase())) return;
        cell.font = { ...current, name: selectedFont };
        cells += 1;
        if (samples.length < 20) samples.push({ sheet: worksheet.name, address: cell.address, previousFont: currentName || null, font: selectedFont });
      });
    });
  }
  return { status: "applied", font: selectedFont, cells, samples };
}

function autoFitRows(worksheet, { min = 15, max = 90, lineHeight = 15, sampleRows = 5000 } = {}) {
  const lastRow = Math.min(Math.max(worksheet.rowCount, worksheet.actualRowCount, 1), sampleRows);
  const lastColumn = Math.max(worksheet.columnCount, worksheet.actualColumnCount, 1);
  for (let row = 1; row <= lastRow; row += 1) {
    let lines = 1;
    for (let column = 1; column <= lastColumn; column += 1) {
      const cell = worksheet.getCell(row, column);
      if (!cell.alignment?.wrapText) continue;
      const width = Math.max(1, worksheet.getColumn(column).width ?? 8);
      const textLines = displayCellText(cell).split(/\r?\n/).reduce((count, line) => count + Math.max(1, Math.ceil(visualTextWidth(line) / width)), 0);
      lines = Math.max(lines, textLines);
    }
    if (!worksheet.getRow(row).height) worksheet.getRow(row).height = Math.min(max, Math.max(min, lines * lineHeight));
  }
}

function serializableValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return safeDateIso(value) ?? "<Invalid Date>";
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
  if (Array.isArray(value)) return value.map(serializableValue);
  if (typeof value === "object") {
    const output = {};
    for (const [key, nested] of Object.entries(value)) output[key] = serializableValue(nested);
    return output;
  }
  return value;
}

function styleSummary(cell) {
  const style = {};
  if (cell.numFmt) style.numberFormat = cell.numFmt;
  if (cell.font && Object.keys(cell.font).length > 0) style.font = serializableValue(cell.font);
  if (cell.fill && cell.fill.type) style.fill = serializableValue(cell.fill);
  if (cell.border && Object.keys(cell.border).length > 0) style.border = serializableValue(cell.border);
  if (cell.alignment && Object.keys(cell.alignment).length > 0) style.alignment = serializableValue(cell.alignment);
  return style;
}

function rawFormulaResult(cell, value = cell?.value) {
  return value && typeof value === "object" && Object.hasOwn(value, "result") ? value.result : cell?.result;
}

function formulaDescriptor(cell) {
  const value = cell.value;
  if (!value || typeof value !== "object") return null;
  if (!("formula" in value) && !("sharedFormula" in value)) return null;
  const result = rawFormulaResult(cell, value);
  return {
    address: cell.address,
    formula: value.formula ?? null,
    sharedFormula: value.sharedFormula ?? null,
    result: serializableValue(result),
  };
}

function errorFromValue(value) {
  if (typeof value === "string" && FORMULA_ERROR_RE.test(value)) return value.match(FORMULA_ERROR_RE)?.[0] ?? value;
  if (value && typeof value === "object") {
    if (typeof value.error === "string" && FORMULA_ERROR_RE.test(value.error)) return value.error;
    if (typeof value.result === "string" && FORMULA_ERROR_RE.test(value.result)) return value.result;
    if (value.result && typeof value.result === "object" && typeof value.result.error === "string") return value.result.error;
  }
  return null;
}

function collectWorkbookFacts(workbook, { maxFormulas = 500, maxErrors = 500 } = {}) {
  const formulas = [];
  const errors = [];
  const missingCachedResults = [];
  const formulaReferencesWithErrors = [];
  const invalidDates = [];
  let formulaCount = 0;

  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const formula = formulaDescriptor(cell);
        if (formula) {
          formulaCount += 1;
          if (formulas.length < maxFormulas) formulas.push({ sheet: worksheet.name, ...formula });
          if (formula.result === null && missingCachedResults.length < maxErrors) {
            missingCachedResults.push({ sheet: worksheet.name, address: cell.address, formula: formula.formula });
          }
          if (typeof formula.formula === "string" && FORMULA_ERROR_RE.test(formula.formula)) {
            formulaReferencesWithErrors.push({ sheet: worksheet.name, address: cell.address, formula: formula.formula });
          }
        }
        const error = errorFromValue(cell.value);
        if (error && errors.length < maxErrors) errors.push({ sheet: worksheet.name, address: cell.address, error });
        const candidateDates = [
          { source: "value", value: cell.value },
          { source: "formula_result", value: formula ? rawFormulaResult(cell) : null },
        ];
        for (const candidate of candidateDates) {
          if (candidate.value instanceof Date && !isValidDate(candidate.value) && invalidDates.length < maxErrors) {
            invalidDates.push({ sheet: worksheet.name, address: cell.address, source: candidate.source, numberFormat: cell.numFmt ?? null });
          }
        }
      });
    });
  }

  return { formulaCount, formulas, errors, missingCachedResults, formulaReferencesWithErrors, invalidDates };
}

function taskValidationProfile(requirements) {
  if (requirements?.task?.protocol === TASK_PROTOCOL && requirements.task.validationProfile) return requirements.task.validationProfile;
  return requirements?.numericIntegrity ? "strict" : "standard";
}

function workbookDataFingerprint(workbook) {
  const digest = crypto.createHash("sha256");
  for (const worksheet of workbook.worksheets) {
    digest.update(`sheet\0${worksheet.name}\0`);
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const formula = formulaDescriptor(cell);
        const value = formula
          ? { formula: formula.formula, sharedFormula: formula.sharedFormula }
          : serializableValue(cell.value);
        digest.update(`${cell.address}\0${JSON.stringify(value)}\0`);
      });
    });
  }
  return digest.digest("hex");
}

async function inspectPackage(filePath) {
  const data = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(data);
  const entries = Object.keys(zip.files).filter((entry) => !zip.files[entry].dir);
  const count = (predicate) => entries.filter(predicate).length;
  const drawingInspection = await inspectDrawingPackage(zip, { DOMParser });
  const drawings = drawingInspection.parts;
  const drawingObjectCount = drawings.reduce((total, drawing) => total + drawing.objects, 0);

  const features = {
    macros: count((entry) => /(?:^|\/)vbaProject\.bin$/i.test(entry)),
    charts: count((entry) => /^xl\/charts\/chart\d+\.xml$/i.test(entry)),
    pivotTables: count((entry) => /^xl\/(?:pivotTables|pivotCache)\//i.test(entry)),
    slicers: count((entry) => /^xl\/(?:slicers|slicerCaches)\//i.test(entry)),
    externalLinks: count((entry) => /^xl\/externalLinks\//i.test(entry)),
    connections: count((entry) => /^xl\/connections\.xml$/i.test(entry)),
    queryTables: count((entry) => /^xl\/queryTables\//i.test(entry)),
    drawings: drawingObjectCount,
    drawingParts: drawings.length,
    media: count((entry) => /^xl\/media\//i.test(entry)),
    embeddings: count((entry) => /^xl\/embeddings\//i.test(entry)),
    activeX: count((entry) => /^xl\/activeX\//i.test(entry)),
    threadedComments: count((entry) => /^xl\/threadedComments\//i.test(entry)),
    comments: count((entry) => /^xl\/comments\d+\.xml$/i.test(entry)),
    customXml: count((entry) => /^customXml\//i.test(entry)),
    signatures: count((entry) => /^_xmlsignatures\//i.test(entry)),
    tables: count((entry) => /^xl\/tables\/table\d+\.xml$/i.test(entry)),
  };

  const charts = await inspectNativeCharts(zip);
  const compatibilityIssues = [
    ...await collectSpreadsheetCompatibilityIssues(zip),
    ...drawingInspection.issues,
  ];

  const risks = Object.entries(features)
    .filter(([name, amount]) => amount > 0 && HARD_RISK_FEATURES.has(name))
    .map(([name, amount]) => ({ feature: name, count: amount }));

  return {
    entryCount: entries.length,
    features,
    charts,
    drawings,
    compatibility: {
      status: compatibilityIssues.length > 0 ? "error" : "ok",
      issues: compatibilityIssues,
    },
    unsafeForRoundTrip: risks.length > 0,
    roundTripRisks: risks,
  };
}

function tableSummaries(worksheet) {
  const tables = worksheet.model?.tables;
  if (!Array.isArray(tables)) return [];
  return tables.map((table) => ({
    name: table.name ?? table.displayName ?? null,
    ref: table.tableRef ?? table.ref ?? null,
    headerRow: table.headerRow ?? null,
    totalsRow: table.totalsRow ?? null,
  }));
}

function worksheetSummary(worksheet) {
  return {
    name: worksheet.name,
    state: worksheet.state,
    rowCount: worksheet.rowCount,
    actualRowCount: worksheet.actualRowCount,
    columnCount: worksheet.columnCount,
    actualColumnCount: worksheet.actualColumnCount,
    mergedRanges: Array.isArray(worksheet.model?.merges) ? worksheet.model.merges : [],
    tables: tableSummaries(worksheet),
    views: serializableValue(worksheet.views),
    pageSetup: serializableValue(worksheet.pageSetup),
  };
}

function selectedRange(worksheet, requestedRange, maxRows, maxCols) {
  const usedRows = Math.max(worksheet.rowCount, worksheet.actualRowCount, 1);
  const usedCols = Math.max(worksheet.columnCount, worksheet.actualColumnCount, 1);
  const requested = requestedRange
    ? parseRangeReference(requestedRange)
    : { startRow: 1, startCol: 1, endRow: usedRows, endCol: usedCols };
  const endRow = Math.min(requested.endRow, requested.startRow + maxRows - 1);
  const endCol = Math.min(requested.endCol, requested.startCol + maxCols - 1);
  return { ...requested, endRow, endCol };
}

function inspectCells(worksheet, range, includeStyles) {
  const cells = [];
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    for (let col = range.startCol; col <= range.endCol; col += 1) {
      const cell = worksheet.getCell(row, col);
      const formula = formulaDescriptor(cell);
      const hasStyle = cell.style && Object.keys(cell.style).length > 0;
      if (cell.value === null && !formula && !(includeStyles && hasStyle)) continue;
      const record = {
        address: cell.address,
        value: formula ? serializableValue(formula.result) : serializableValue(cell.value),
      };
      if (formula) record.formula = formula.formula ?? { sharedFormula: formula.sharedFormula };
      if (includeStyles) record.style = styleSummary(cell);
      cells.push(record);
    }
  }
  return cells;
}

async function inspectXlsx(filePath, options = {}) {
  const workbook = await loadXlsx(filePath);
  const packageInfo = await inspectPackage(filePath);
  const maxRows = integerOption(options, "max-rows", 30);
  const maxCols = integerOption(options, "max-cols", 20);
  const worksheet = options.sheet
    ? workbook.getWorksheet(String(options.sheet))
    : workbook.worksheets[0];
  if (!worksheet) throw new Error(options.sheet ? `Worksheet '${options.sheet}' was not found` : "Workbook has no worksheets");
  const range = selectedRange(worksheet, options.range ? String(options.range) : null, maxRows, maxCols);
  const facts = collectWorkbookFacts(workbook, { maxFormulas: integerOption(options, "max-formulas", 100) });
  return {
    status: "ok",
    path: path.resolve(filePath),
    format: "xlsx",
    workbook: {
      creator: workbook.creator ?? null,
      modified: workbook.modified ?? null,
      worksheetCount: workbook.worksheets.length,
      worksheets: workbook.worksheets.map(worksheetSummary),
      definedNames: serializableValue(workbook.definedNames?.model ?? []),
    },
    package: packageInfo,
    selection: {
      sheet: worksheet.name,
      range: `${columnLetters(range.startCol)}${range.startRow}:${columnLetters(range.endCol)}${range.endRow}`,
      truncated: Boolean(options.range) ? false : worksheet.rowCount > maxRows || worksheet.columnCount > maxCols,
      cells: inspectCells(worksheet, range, Boolean(options.styles)),
    },
    formulas: {
      count: facts.formulaCount,
      items: facts.formulas,
    },
  };
}

async function inspectDelimited(filePath, options = {}) {
  const extension = assertSupportedInput(filePath);
  const delimiter = extension === ".tsv" ? "\t" : ",";
  const decoded = decodeDelimitedBuffer(await fs.readFile(filePath), options.encoding ?? "auto");
  const rows = parseDelimitedText(decoded.text, {
    bom: true,
    delimiter,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
  });
  const maxRows = integerOption(options, "max-rows", 30);
  const maxCols = integerOption(options, "max-cols", 20);
  const widths = rows.map((row) => row.length);
  return {
    status: "ok",
    path: path.resolve(filePath),
    format: extension.slice(1),
    encoding: decoded.encoding,
    delimiter: extension === ".tsv" ? "tab" : "comma",
    rowCount: rows.length,
    maxColumnCount: widths.length > 0 ? Math.max(...widths) : 0,
    inconsistentRowWidths: [...new Set(widths)].length > 1,
    preview: rows.slice(0, maxRows).map((row) => row.slice(0, maxCols)),
    truncated: rows.length > maxRows || widths.some((width) => width > maxCols),
  };
}

const REQUIREMENT_KEYS = new Set([
  "task",
  "sourceBacked",
  "sourceFiles",
  "sourceBackedSheets",
  "numericIntegrity",
  "requiredSheets",
  "exactSheetCount",
  "minFormulaCount",
  "requiredFormulaRanges",
  "requiredNonEmptyRanges",
  "expectedCells",
  "expectedRanges",
  "requiredCellTypes",
  "requiredNativeCharts",
  "requiredTables",
  "requiredConditionalFormatting",
  "requiredDataValidations",
  "requiredImages",
  "maxTotalPages",
  "maxPagesPerSheet",
  "warningDispositions",
]);

const REQUIREMENT_ARRAY_KEYS = [
  "sourceFiles",
  "sourceBackedSheets",
  "requiredSheets",
  "requiredFormulaRanges",
  "requiredNonEmptyRanges",
  "expectedCells",
  "expectedRanges",
  "requiredCellTypes",
  "requiredNativeCharts",
  "requiredTables",
  "requiredConditionalFormatting",
  "requiredDataValidations",
  "requiredImages",
  "maxPagesPerSheet",
  "warningDispositions",
];

function validateRequirements(requirements, source = "requirements") {
  if (requirements === null || requirements === undefined) return null;
  if (typeof requirements !== "object" || Array.isArray(requirements)) {
    throw new Error(`${source} must be a JSON object`);
  }
  if (Object.hasOwn(requirements, "coverage") || Object.hasOwn(requirements, "status")) {
    throw new Error(`${source} must declare checks, not audit results; remove coverage/status`);
  }
  const unknown = Object.keys(requirements).filter((key) => !REQUIREMENT_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`${source} contains unsupported key(s): ${unknown.join(", ")}`);
  for (const key of REQUIREMENT_ARRAY_KEYS) {
    if (requirements[key] !== undefined && !Array.isArray(requirements[key])) {
      throw new Error(`${source}.${key} must be an array`);
    }
  }
  if (requirements.task !== undefined) {
    const task = requirements.task;
    if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error(`${source}.task must be an object`);
    const taskKeys = new Set([
      "protocol", "workbookType", "styleMode", "styleSource", "input", "finalOutput",
      "visualReview", "allowDecorativeTitle", "allowedAccentColors", "projectSnapshot",
      "validationProfile", "minimumValidationProfile", "dataOperation", "profileReasons",
    ]);
    const unknownTaskKeys = Object.keys(task).filter((key) => !taskKeys.has(key));
    if (unknownTaskKeys.length > 0) throw new Error(`${source}.task contains unsupported key(s): ${unknownTaskKeys.join(", ")}`);
    if (![TASK_PROTOCOL, LEGACY_TASK_PROTOCOL].includes(task.protocol)) {
      throw new Error(`${source}.task.protocol must be '${TASK_PROTOCOL}' or '${LEGACY_TASK_PROTOCOL}'`);
    }
    if (!WORKBOOK_TYPES.has(task.workbookType)) throw new Error(`${source}.task.workbookType is invalid`);
    if (!STYLE_MODES.has(task.styleMode)) throw new Error(`${source}.task.styleMode is invalid`);
    if (typeof task.finalOutput !== "string" || !path.isAbsolute(task.finalOutput) || workbookExtension(task.finalOutput) !== ".xlsx") {
      throw new Error(`${source}.task.finalOutput must be an absolute .xlsx path`);
    }
    if (task.input !== undefined) {
      if (!task.input || typeof task.input.path !== "string" || !path.isAbsolute(task.input.path) || !/^[a-f0-9]{64}$/i.test(String(task.input.sha256 ?? ""))) {
        throw new Error(`${source}.task.input requires an absolute path and SHA-256 hash`);
      }
    }
    if (task.styleMode === "preserve-source" && !task.input) throw new Error(`${source}.task.input is required for preserve-source style mode`);
    if (task.styleMode === "user-template") {
      if (!task.styleSource || typeof task.styleSource.path !== "string" || !path.isAbsolute(task.styleSource.path) || !/^[a-f0-9]{64}$/i.test(String(task.styleSource.sha256 ?? ""))) {
        throw new Error(`${source}.task.styleSource requires an absolute path and SHA-256 hash for user-template mode`);
      }
    } else if (task.styleSource !== undefined) {
      throw new Error(`${source}.task.styleSource is only valid for user-template mode`);
    }
    if (!task.visualReview || !VISUAL_REVIEW_MODES.has(task.visualReview.mode)) throw new Error(`${source}.task.visualReview.mode is invalid`);
    if (task.visualReview.mode === "selected-sheets" && (!Array.isArray(task.visualReview.sheets) || task.visualReview.sheets.length === 0)) {
      throw new Error(`${source}.task.visualReview.sheets is required for selected-sheets mode`);
    }
    if (task.allowDecorativeTitle !== undefined && typeof task.allowDecorativeTitle !== "boolean") {
      throw new Error(`${source}.task.allowDecorativeTitle must be true or false`);
    }
    if (task.allowedAccentColors !== undefined && (!Array.isArray(task.allowedAccentColors) || task.allowedAccentColors.some((color) => !/^[A-F0-9]{8}$/i.test(String(color))))) {
      throw new Error(`${source}.task.allowedAccentColors must contain ARGB color strings`);
    }
    if (task.protocol === TASK_PROTOCOL) {
      if (task.validationProfile !== undefined && !VALIDATION_PROFILES.includes(task.validationProfile)) throw new Error(`${source}.task.validationProfile is invalid`);
      if (task.minimumValidationProfile !== undefined && !VALIDATION_PROFILES.includes(task.minimumValidationProfile)) throw new Error(`${source}.task.minimumValidationProfile is invalid`);
      if (task.dataOperation !== undefined && !DATA_OPERATIONS.includes(task.dataOperation)) throw new Error(`${source}.task.dataOperation is invalid`);
      if (task.profileReasons !== undefined && (!Array.isArray(task.profileReasons) || task.profileReasons.some((reason) => typeof reason !== "string" || reason.trim().length === 0))) {
        throw new Error(`${source}.task.profileReasons must contain non-empty strings`);
      }
    }
    if (task.projectSnapshot !== undefined) {
      const snapshot = task.projectSnapshot;
      if (!snapshot || ![PROJECT_SNAPSHOT_PROTOCOL, PROJECT_GUARD_PROTOCOL].includes(snapshot.protocol)
        || typeof snapshot.path !== "string" || !path.isAbsolute(snapshot.path)
        || !/^[a-f0-9]{64}$/i.test(String(snapshot.sha256 ?? ""))) {
        throw new Error(`${source}.task.projectSnapshot requires protocol, an absolute path, and a SHA-256 hash`);
      }
    }
  }
  if (requirements.requiredSheets?.some((sheet) => typeof sheet !== "string" || sheet.trim().length === 0)) {
    throw new Error(`${source}.requiredSheets must contain non-empty worksheet names`);
  }
  if (requirements.sourceBacked !== undefined && typeof requirements.sourceBacked !== "boolean") {
    throw new Error(`${source}.sourceBacked must be true or false`);
  }
  if (requirements.sourceBackedSheets?.some((sheet) => typeof sheet !== "string" || sheet.trim().length === 0)) {
    throw new Error(`${source}.sourceBackedSheets must contain non-empty worksheet names`);
  }
  for (const [index, sourceFile] of (requirements.sourceFiles ?? []).entries()) {
    if (!sourceFile || typeof sourceFile.path !== "string" || !path.isAbsolute(sourceFile.path)
      || !/^[a-f0-9]{64}$/i.test(String(sourceFile.sha256 ?? ""))) {
      throw new Error(`${source}.sourceFiles[${index}] requires an absolute path and SHA-256 hash`);
    }
    if (sourceFile.origin !== undefined && (!sourceFile.origin
      || typeof sourceFile.origin.path !== "string" || !path.isAbsolute(sourceFile.origin.path)
      || !/^[a-f0-9]{64}$/i.test(String(sourceFile.origin.sha256 ?? "")))) {
      throw new Error(`${source}.sourceFiles[${index}].origin requires an absolute path and SHA-256 hash`);
    }
  }
  if (requirements.numericIntegrity !== undefined) {
    const integrity = requirements.numericIntegrity;
    if (!integrity || typeof integrity !== "object" || Array.isArray(integrity)) {
      throw new Error(`${source}.numericIntegrity must be an object`);
    }
    const allowedIntegrityKeys = new Set(["protocol", "mode", "state", "evidence", "plan", "blockOnUnverified"]);
    const unknownIntegrityKeys = Object.keys(integrity).filter((key) => !allowedIntegrityKeys.has(key));
    if (unknownIntegrityKeys.length > 0) throw new Error(`${source}.numericIntegrity contains unsupported key(s): ${unknownIntegrityKeys.join(", ")}`);
    if (integrity.protocol !== NUMERIC_INTEGRITY_PROTOCOL) {
      throw new Error(`${source}.numericIntegrity.protocol must be '${NUMERIC_INTEGRITY_PROTOCOL}'`);
    }
    if (integrity.mode !== "strict") throw new Error(`${source}.numericIntegrity.mode must be 'strict'`);
    if (!NUMERIC_INTEGRITY_STATES.has(integrity.state)) {
      throw new Error(`${source}.numericIntegrity.state must be prepared or bound`);
    }
    if (integrity.blockOnUnverified !== true) {
      throw new Error(`${source}.numericIntegrity.blockOnUnverified must be true`);
    }
    for (const [bindingName, binding] of [["evidence", integrity.evidence], ["plan", integrity.plan]]) {
      if (!binding || typeof binding !== "object" || Array.isArray(binding) || typeof binding.path !== "string" || !path.isAbsolute(binding.path)) {
        throw new Error(`${source}.numericIntegrity.${bindingName} requires an absolute path`);
      }
      if (binding.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(String(binding.sha256))) {
        throw new Error(`${source}.numericIntegrity.${bindingName}.sha256 must be a SHA-256 hash`);
      }
      if (integrity.state === "bound" && !/^[a-f0-9]{64}$/i.test(String(binding.sha256 ?? ""))) {
        throw new Error(`${source}.numericIntegrity.${bindingName}.sha256 is required after integrity-bind`);
      }
    }
  }
  for (const [key, value] of [["exactSheetCount", requirements.exactSheetCount], ["minFormulaCount", requirements.minFormulaCount], ["maxTotalPages", requirements.maxTotalPages]]) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`${source}.${key} must be a non-negative integer`);
    }
  }
  for (const [index, disposition] of (requirements.warningDispositions ?? []).entries()) {
    if (!disposition || typeof disposition.type !== "string" || disposition.type.trim().length === 0 || typeof disposition.rationale !== "string" || disposition.rationale.trim().length === 0) {
      throw new Error(`${source}.warningDispositions[${index}] requires non-empty type and rationale strings`);
    }
  }
  for (const [index, sourceFile] of (requirements.sourceFiles ?? []).entries()) {
    if (!sourceFile || typeof sourceFile.path !== "string" || !path.isAbsolute(sourceFile.path) || !/^[a-f0-9]{64}$/i.test(String(sourceFile.sha256 ?? ""))) {
      throw new Error(`${source}.sourceFiles[${index}] requires an absolute path and SHA-256 hash`);
    }
  }
  for (const key of ["requiredFormulaRanges", "requiredNonEmptyRanges"]) {
    for (const [index, item] of (requirements[key] ?? []).entries()) {
      if (!item || typeof item.sheet !== "string" || item.sheet.trim().length === 0 || typeof item.range !== "string" || item.range.trim().length === 0) {
        throw new Error(`${source}.${key}[${index}] requires non-empty sheet and range strings`);
      }
      const bounds = parseRangeReference(item.range);
      const cells = (bounds.endRow - bounds.startRow + 1) * (bounds.endCol - bounds.startCol + 1);
      if (item.minCount !== undefined && (!Number.isInteger(item.minCount) || item.minCount < 1 || item.minCount > cells)) {
        throw new Error(`${source}.${key}[${index}].minCount must be between 1 and ${cells} for ${item.range}`);
      }
    }
  }
  for (const [index, item] of (requirements.expectedCells ?? []).entries()) {
    if (!item || typeof item.sheet !== "string" || item.sheet.trim().length === 0 || typeof item.cell !== "string" || item.cell.trim().length === 0 || !Object.hasOwn(item, "value")) {
      throw new Error(`${source}.expectedCells[${index}] requires non-empty sheet/cell strings and a value`);
    }
    parseCellReference(item.cell);
    if (item.tolerance !== undefined && (!Number.isFinite(item.tolerance) || item.tolerance < 0)) {
      throw new Error(`${source}.expectedCells[${index}].tolerance must be a non-negative number`);
    }
  }
  for (const [index, item] of (requirements.expectedRanges ?? []).entries()) {
    if (!item || typeof item.sheet !== "string" || typeof item.range !== "string" || !Array.isArray(item.values) || item.values.length === 0 || item.values.some((row) => !Array.isArray(row))) {
      throw new Error(`${source}.expectedRanges[${index}] requires sheet, range, and a non-empty values matrix`);
    }
    const bounds = parseRangeReference(item.range);
    const expectedRows = bounds.endRow - bounds.startRow + 1;
    const expectedColumns = bounds.endCol - bounds.startCol + 1;
    if (item.values.length !== expectedRows || item.values.some((row) => row.length !== expectedColumns)) {
      throw new Error(`${source}.expectedRanges[${index}].values must match ${item.range} (${expectedRows}x${expectedColumns})`);
    }
    if (item.tolerance !== undefined && (!Number.isFinite(item.tolerance) || item.tolerance < 0)) {
      throw new Error(`${source}.expectedRanges[${index}].tolerance must be a non-negative number`);
    }
  }
  for (const [index, item] of (requirements.requiredCellTypes ?? []).entries()) {
    if (!item || typeof item.sheet !== "string" || item.sheet.trim().length === 0 || typeof item.range !== "string" || item.range.trim().length === 0) {
      throw new Error(`${source}.requiredCellTypes[${index}] requires non-empty sheet and range strings`);
    }
    const bounds = parseRangeReference(item.range);
    const cells = (bounds.endRow - bounds.startRow + 1) * (bounds.endCol - bounds.startCol + 1);
    if (!new Set(["number", "date", "string", "boolean"]).has(String(item.type ?? "").toLowerCase())) {
      throw new Error(`${source}.requiredCellTypes[${index}].type must be number, date, string, or boolean`);
    }
    if (item.allowBlank !== undefined && typeof item.allowBlank !== "boolean") {
      throw new Error(`${source}.requiredCellTypes[${index}].allowBlank must be true or false`);
    }
    if (item.minCount !== undefined && (!Number.isInteger(item.minCount) || item.minCount < 1 || item.minCount > cells)) {
      throw new Error(`${source}.requiredCellTypes[${index}].minCount must be between 1 and ${cells} for ${item.range}`);
    }
  }
  for (const [index, item] of (requirements.requiredNativeCharts ?? []).entries()) {
    if (item.minPoints !== undefined && (!Number.isInteger(item.minPoints) || item.minPoints < 1)) {
      throw new Error(`${source}.requiredNativeCharts[${index}].minPoints must be a positive integer`);
    }
    if (item.sourceRanges !== undefined && (!Array.isArray(item.sourceRanges) || item.sourceRanges.some((range) => typeof range !== "string" || range.trim().length === 0))) {
      throw new Error(`${source}.requiredNativeCharts[${index}].sourceRanges must contain non-empty ranges`);
    }
  }
  for (const [index, item] of (requirements.requiredImages ?? []).entries()) {
    if (!item || typeof item.sheet !== "string" || item.sheet.trim().length === 0 || (item.minCount !== undefined && (!Number.isInteger(item.minCount) || item.minCount < 1))) {
      throw new Error(`${source}.requiredImages[${index}] requires a sheet and optional positive minCount`);
    }
  }
  for (const [key, locationKey] of [["requiredTables", "sheet"], ["requiredConditionalFormatting", "range"], ["requiredDataValidations", "cell"]]) {
    for (const [index, item] of (requirements[key] ?? []).entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${source}.${key}[${index}] must be an object`);
      if (key !== "requiredTables" && (typeof item.sheet !== "string" || item.sheet.trim().length === 0)) {
        throw new Error(`${source}.${key}[${index}].sheet must be a non-empty string`);
      }
      if (item.sheet !== undefined && (typeof item.sheet !== "string" || item.sheet.trim().length === 0)) {
        throw new Error(`${source}.${key}[${index}].sheet must be a non-empty string`);
      }
      if (item[locationKey] !== undefined && (typeof item[locationKey] !== "string" || item[locationKey].trim().length === 0)) {
        throw new Error(`${source}.${key}[${index}].${locationKey} must be a non-empty string`);
      }
      if (item.minCount !== undefined && (!Number.isInteger(item.minCount) || item.minCount < 1)) {
        throw new Error(`${source}.${key}[${index}].minCount must be a positive integer`);
      }
    }
  }
  for (const [index, item] of (requirements.maxPagesPerSheet ?? []).entries()) {
    if (!item || typeof item.sheet !== "string" || item.sheet.trim().length === 0 || !Number.isInteger(item.max) || item.max < 1) {
      throw new Error(`${source}.maxPagesPerSheet[${index}] requires a non-empty sheet and positive integer max`);
    }
  }
  if (requirements.sourceBacked) {
    if ((requirements.sourceFiles?.length ?? 0) === 0) throw new Error(`${source}.sourceBacked requires sourceFiles`);
    if ((requirements.sourceBackedSheets?.length ?? 0) === 0 && requirements.numericIntegrity?.state !== "prepared") {
      throw new Error(`${source}.sourceBacked requires sourceBackedSheets`);
    }
    for (const sheet of requirements.sourceBackedSheets) {
      const assertions = [
        ...(requirements.expectedCells ?? []).filter((item) => item.sheet === sheet),
        ...(requirements.expectedRanges ?? []).filter((item) => item.sheet === sheet),
      ];
      if (assertions.length === 0 && !requirements.numericIntegrity) {
        throw new Error(`${source}.sourceBackedSheets '${sheet}' requires expectedCells/expectedRanges or bound numericIntegrity coverage`);
      }
    }
  }
  return requirements;
}

async function resolveRequirements(requirementsPath, inlineRequirements = null) {
  let fileRequirements = null;
  if (requirementsPath) fileRequirements = validateRequirements(JSON.parse(await fs.readFile(requirementsPath, "utf8")), path.resolve(requirementsPath));
  const validatedInline = validateRequirements(inlineRequirements, "builder requirements");
  if (!fileRequirements) return validatedInline;
  if (!validatedInline) return fileRequirements;
  const merged = { ...validatedInline, ...fileRequirements };
  for (const key of REQUIREMENT_ARRAY_KEYS) {
    if ((fileRequirements[key]?.length ?? 0) === 0 && (validatedInline[key]?.length ?? 0) > 0) merged[key] = validatedInline[key];
  }
  for (const key of ["exactSheetCount", "minFormulaCount", "maxTotalPages"]) {
    if (fileRequirements[key] === undefined && validatedInline[key] !== undefined) merged[key] = validatedInline[key];
  }
  return validateRequirements(merged, "merged requirements");
}

function normalizeChartFormula(value) {
  return String(value ?? "").replaceAll("$", "").replaceAll("''", "'").toLowerCase();
}

function valuesEqual(actual, expected, tolerance = 0) {
  if (typeof expected === "number") return typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  if (typeof expected === "string" && /^\d{4}-\d{2}-\d{2}$/.test(expected) && actual instanceof Date && isValidDate(actual)) {
    return actual.toISOString().startsWith(expected);
  }
  if (typeof expected === "string" && /^\d{4}-\d{2}-\d{2}$/.test(expected) && typeof actual === "string") {
    return actual.startsWith(expected);
  }
  return String(actual ?? "") === String(expected ?? "");
}

function effectiveCellValue(cell) {
  return cell && formulaDescriptor(cell) ? rawFormulaResult(cell) : cell?.value;
}

function cellValueType(cell) {
  const value = effectiveCellValue(cell);
  if (value === null || value === undefined || value === "") return "blank";
  if (value instanceof Date) return isValidDate(value) ? "date" : "invalid_date";
  if (typeof value === "number") return Number.isFinite(value) ? "number" : "invalid_number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (value && typeof value === "object") {
    if (typeof value.error === "string") return "error";
    if (typeof value.text === "string" || Array.isArray(value.richText)) return "string";
  }
  return typeof value;
}

function evaluateRequirements(workbook, packageInfo, requirements) {
  if (!requirements) return { status: "not_requested", total: 0, passed: 0, checks: [], failures: [] };
  const checks = [];
  const record = (type, passed, details = {}) => checks.push({ type, passed, ...details });

  for (const sheetName of requirements.requiredSheets ?? []) {
    record("required_sheet", Boolean(workbook.getWorksheet(sheetName)), { sheet: sheetName });
  }
  if (Number.isFinite(requirements.exactSheetCount)) {
    record("exact_sheet_count", workbook.worksheets.length === requirements.exactSheetCount, { expected: requirements.exactSheetCount, actual: workbook.worksheets.length });
  }
  if (Number.isFinite(requirements.minFormulaCount)) {
    const actual = collectWorkbookFacts(workbook).formulaCount;
    record("min_formula_count", actual >= requirements.minFormulaCount, { expected: requirements.minFormulaCount, actual });
  }
  for (const item of requirements.requiredFormulaRanges ?? []) {
    const worksheet = workbook.getWorksheet(item.sheet);
    let actual = 0;
    let expected = 0;
    if (worksheet) {
      forEachCellInRange(worksheet, item.range, (cell) => {
        expected += 1;
        if (formulaDescriptor(cell)) actual += 1;
      });
    }
    const minimum = item.minCount ?? expected;
    record("required_formula_range", Boolean(worksheet) && actual >= minimum, { sheet: item.sheet, range: item.range, expected: minimum, actual });
  }
  for (const item of requirements.requiredNonEmptyRanges ?? []) {
    const worksheet = workbook.getWorksheet(item.sheet);
    let actual = 0;
    let expected = 0;
    if (worksheet) {
      forEachCellInRange(worksheet, item.range, (cell) => {
        expected += 1;
        if (displayCellText(cell).trim() !== "") actual += 1;
      });
    }
    const minimum = item.minCount ?? expected;
    record("required_non_empty_range", Boolean(worksheet) && actual >= minimum, { sheet: item.sheet, range: item.range, expected: minimum, actual });
  }
  for (const item of requirements.expectedCells ?? []) {
    const cell = workbook.getWorksheet(item.sheet)?.getCell(item.cell);
    const actual = cell ? cellDisplayValueForAudit(cell) : null;
    record("expected_cell", Boolean(cell) && valuesEqual(actual, item.value, item.tolerance ?? 0), { sheet: item.sheet, cell: item.cell, expected: item.value, actual });
  }
  for (const item of requirements.expectedRanges ?? []) {
    const worksheet = workbook.getWorksheet(item.sheet);
    const bounds = parseRangeReference(item.range);
    const mismatches = [];
    let matched = 0;
    let total = 0;
    for (let rowOffset = 0; rowOffset < item.values.length; rowOffset += 1) {
      for (let columnOffset = 0; columnOffset < item.values[rowOffset].length; columnOffset += 1) {
        total += 1;
        const address = `${columnLetters(bounds.startCol + columnOffset)}${bounds.startRow + rowOffset}`;
        const actual = worksheet ? cellDisplayValueForAudit(worksheet.getCell(address)) : null;
        const expected = item.values[rowOffset][columnOffset];
        if (worksheet && valuesEqual(actual, expected, item.tolerance ?? 0)) matched += 1;
        else if (mismatches.length < 100) mismatches.push({ address, expected, actual });
      }
    }
    record("expected_range", Boolean(worksheet) && matched === total, { sheet: item.sheet, range: item.range, expected: total, actual: matched, mismatches });
  }
  for (const item of requirements.requiredCellTypes ?? []) {
    const worksheet = workbook.getWorksheet(item.sheet);
    const expectedType = String(item.type ?? "").toLowerCase();
    const supportedTypes = new Set(["number", "date", "string", "boolean"]);
    if (!supportedTypes.has(expectedType)) throw new Error(`Unsupported requiredCellTypes type '${item.type}'`);
    const mismatches = [];
    const counts = {};
    let total = 0;
    let nonBlank = 0;
    let matched = 0;
    if (worksheet) {
      forEachCellInRange(worksheet, item.range, (cell) => {
        total += 1;
        const actualType = cellValueType(cell);
        counts[actualType] = (counts[actualType] ?? 0) + 1;
        if (actualType === "blank" && item.allowBlank) return;
        if (actualType !== "blank") nonBlank += 1;
        if (actualType === expectedType) matched += 1;
        else if (mismatches.length < 100) mismatches.push({ address: cell.address, actualType, value: serializableValue(effectiveCellValue(cell)), numberFormat: cell.numFmt ?? null });
      });
    }
    const minimum = item.minCount ?? (item.allowBlank ? nonBlank : total);
    record("required_cell_type", Boolean(worksheet) && matched >= minimum && mismatches.length === 0, {
      sheet: item.sheet,
      range: item.range,
      expectedType,
      minimum,
      matched,
      counts,
      mismatches,
    });
  }
  for (const item of requirements.requiredNativeCharts ?? []) {
    const candidates = packageInfo.charts.filter((chart) => {
      if (item.sheet && chart.sheet !== item.sheet) return false;
      if (item.type && !chart.types.includes(item.type)) return false;
      if (Array.isArray(item.sourceRanges)) {
        const actual = chart.sourceFormulas.map(normalizeChartFormula);
        if (!item.sourceRanges.every((range) => actual.some((formula) => formula.includes(normalizeChartFormula(range))))) return false;
      }
      if (Number.isInteger(item.minPoints)) {
        if ((chart.series ?? []).length === 0 || chart.series.some((series) => {
          const stats = chartPointStats(workbook, series);
          return !stats
            || stats.categories !== stats.values
            || stats.blankCategories > 0
            || stats.blankValues > 0
            || stats.numericValues < item.minPoints;
        })) return false;
      }
      return true;
    });
    const minimum = item.minCount ?? 1;
    record("required_native_chart", candidates.length >= minimum, { sheet: item.sheet ?? null, chartType: item.type ?? null, expected: minimum, actual: candidates.length, sourceRanges: item.sourceRanges ?? [], minPoints: item.minPoints ?? null });
  }
  for (const item of requirements.requiredTables ?? []) {
    const worksheets = item.sheet ? [workbook.getWorksheet(item.sheet)].filter(Boolean) : workbook.worksheets;
    const actual = worksheets.reduce((total, worksheet) => total + tableSummaries(worksheet).length, 0);
    const minimum = item.minCount ?? 1;
    record("required_table", actual >= minimum, { sheet: item.sheet ?? null, expected: minimum, actual });
  }
  for (const item of requirements.requiredConditionalFormatting ?? []) {
    const worksheet = workbook.getWorksheet(item.sheet);
    const ranges = worksheet?.conditionalFormattings?.map((entry) => entry.ref) ?? [];
    const passed = Boolean(worksheet) && (item.range ? ranges.includes(item.range) : ranges.length > 0);
    record("required_conditional_formatting", passed, { sheet: item.sheet, range: item.range ?? null, actualRanges: ranges });
  }
  for (const item of requirements.requiredDataValidations ?? []) {
    const worksheet = workbook.getWorksheet(item.sheet);
    const model = worksheet?.dataValidations?.model ?? {};
    const addresses = Object.keys(model);
    const passed = Boolean(worksheet) && (item.cell ? addresses.includes(item.cell) : addresses.length > 0);
    record("required_data_validation", passed, { sheet: item.sheet, cell: item.cell ?? null, actualCells: addresses.slice(0, 100) });
  }
  for (const item of requirements.requiredImages ?? []) {
    const worksheet = workbook.getWorksheet(item.sheet);
    const images = typeof worksheet?.getImages === "function" ? worksheet.getImages() : [];
    const minimum = item.minCount ?? 1;
    record("required_image", Boolean(worksheet) && images.length >= minimum, {
      sheet: item.sheet,
      expected: minimum,
      actual: images.length,
      packageMedia: packageInfo.features.media,
    });
  }

  const semanticAssertionCount = [
    ...(requirements.expectedCells ?? []),
    ...(requirements.expectedRanges ?? []),
    ...(requirements.requiredNonEmptyRanges ?? []),
    ...(requirements.requiredCellTypes ?? []),
    ...(requirements.requiredNativeCharts ?? []),
    ...(requirements.requiredTables ?? []),
    ...(requirements.requiredConditionalFormatting ?? []),
    ...(requirements.requiredDataValidations ?? []),
    ...(requirements.requiredImages ?? []),
    ...(requirements.numericIntegrity ? [requirements.numericIntegrity] : []),
  ].length;
  const profile = taskValidationProfile(requirements);
  const lightweightAssertions = (requirements.requiredSheets?.length ?? 0)
    + (Number.isFinite(requirements.minFormulaCount) ? 1 : 0);
  const semanticFloorPassed = profile === "fast"
    ? semanticAssertionCount + lightweightAssertions > 0
    : semanticAssertionCount > 0 || (profile === "standard" && lightweightAssertions > 0);
  record("semantic_requirement_floor", semanticFloorPassed, { actual: semanticAssertionCount, lightweight: lightweightAssertions, minimum: 1, profile });

  const formulaCount = collectWorkbookFacts(workbook).formulaCount;
  if (formulaCount > 0) {
    const formulaCoverageDeclared = (requirements.requiredFormulaRanges?.length ?? 0) > 0
      || (profile !== "strict" && Number.isInteger(requirements.minFormulaCount) && requirements.minFormulaCount > 0);
    record("formula_requirement_floor", formulaCoverageDeclared, {
      formulaCount,
      requiredFormulaRanges: requirements.requiredFormulaRanges?.length ?? 0,
      minFormulaCount: requirements.minFormulaCount ?? null,
      profile,
    });
  }
  if (packageInfo.charts.length > 0) {
    const chartRequirements = requirements.requiredNativeCharts ?? [];
    const complete = chartRequirements.length > 0 && chartRequirements.every((item) => (
      Array.isArray(item.sourceRanges) && item.sourceRanges.length >= 2 && Number.isInteger(item.minPoints) && item.minPoints >= 1
    ));
    record("native_chart_requirement_floor", complete, { charts: packageInfo.charts.length, declared: chartRequirements.length });
  }
  for (const sheetName of requirements.sourceBackedSheets ?? []) {
    const assertions = [
      ...(requirements.expectedCells ?? []).filter((item) => item.sheet === sheetName),
      ...(requirements.expectedRanges ?? []).filter((item) => item.sheet === sheetName),
    ];
    record("source_backed_sheet_assertions", assertions.length > 0 || requirements.numericIntegrity?.state === "bound", {
      sheet: sheetName,
      assertions: assertions.length,
      numericIntegrity: requirements.numericIntegrity?.state ?? null,
    });
  }

  const failures = checks.filter((check) => !check.passed);
  return { status: failures.length === 0 ? "passed" : "failed", total: checks.length, passed: checks.length - failures.length, checks, failures };
}

function rangeFormulaState(workbook, item, addressKey = "range") {
  const worksheet = workbook.getWorksheet(item.sheet);
  const state = { containsFormula: false, missingResult: false };
  if (!worksheet) return state;
  const visit = (cell) => {
    const formula = formulaDescriptor(cell);
    if (!formula) return;
    state.containsFormula = true;
    if (formula.result === null) state.missingResult = true;
  };
  if (addressKey === "cell") visit(worksheet.getCell(item.cell));
  else forEachCellInRange(worksheet, item.range, visit);
  return state;
}

function validateWorkbookRequirementsPreflight(workbook, requirements) {
  if (!requirements) return { status: "not_requested", failures: [] };
  const coverage = evaluateRequirements(workbook, { charts: [], features: { media: 0 } }, requirements);
  const immediatelyCheckable = new Set([
    "required_sheet",
    "exact_sheet_count",
    "min_formula_count",
    "required_formula_range",
    "required_non_empty_range",
    "required_table",
    "required_conditional_formatting",
    "required_data_validation",
    "semantic_requirement_floor",
    "formula_requirement_floor",
    "source_backed_sheet_assertions",
  ]);
  const failures = coverage.failures.filter((failure) => {
    if (immediatelyCheckable.has(failure.type)) return true;
    if (failure.type === "expected_cell") return !rangeFormulaState(workbook, failure, "cell").containsFormula;
    if (failure.type === "expected_range") return !rangeFormulaState(workbook, failure).containsFormula;
    if (failure.type === "required_cell_type") return !rangeFormulaState(workbook, failure).missingResult;
    return false;
  });
  const styleFailures = collectStylePolicyFailures(workbook, requirements);
  if (failures.length > 0 || styleFailures.length > 0) {
    const problems = [
      ...failures.map((failure) => ({ type: "requirement_not_met", requirement: failure })),
      ...styleFailures,
    ];
    throw new Error(`Builder output cannot satisfy its declared requirements before serialization. ${summarizeFailures(problems)}`);
  }
  return { status: "passed", failures: [] };
}

async function evaluateSourceFiles(requirements) {
  if (!requirements?.sourceBacked) return [];
  const checks = [];
  for (const sourceFile of requirements.sourceFiles ?? []) {
    const exists = await pathExists(sourceFile.path);
    const actual = exists ? await fileSha256(sourceFile.path) : null;
    checks.push({
      type: "source_file_integrity",
      passed: exists && actual === sourceFile.sha256.toLowerCase(),
      path: sourceFile.path,
      expectedSha256: sourceFile.sha256.toLowerCase(),
      actualSha256: actual,
    });
    if (sourceFile.origin) {
      const originExists = await pathExists(sourceFile.origin.path);
      const originActual = originExists ? await fileSha256(sourceFile.origin.path) : null;
      checks.push({
        type: "source_origin_integrity",
        passed: originExists && originActual === sourceFile.origin.sha256.toLowerCase(),
        path: sourceFile.origin.path,
        expectedSha256: sourceFile.origin.sha256.toLowerCase(),
        actualSha256: originActual,
        effectivePath: sourceFile.path,
      });
    }
  }
  return checks;
}

function assertEvidenceSource(filePath) {
  const extension = workbookExtension(filePath);
  if (![".xlsx", ".csv", ".tsv", ...EVIDENCE_IMAGE_EXTENSIONS].includes(extension)) {
    throw new Error(`Unsupported numeric-integrity source '${extension || "(none)"}': ${filePath}`);
  }
  return extension;
}

function worksheetEvidenceSummary(worksheet) {
  const digest = crypto.createHash("sha256");
  const typeCounts = {};
  let populatedCells = 0;
  let formulaCells = 0;
  let numericCells = 0;
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const value = effectiveCellValue(cell);
      const type = cellValueType(cell);
      populatedCells += 1;
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
      if (type === "number") numericCells += 1;
      const formula = formulaDescriptor(cell);
      if (formula) formulaCells += 1;
      digest.update(JSON.stringify({
        address: cell.address,
        type,
        value: serializableValue(value),
        formula: formula?.formula ?? null,
        result: formula ? serializableValue(formula.result) : null,
        numberFormat: cell.numFmt ?? null,
      }));
      digest.update("\n");
    });
  });
  const lastColumn = Math.max(worksheet.actualColumnCount, 1);
  const lastRow = Math.max(worksheet.actualRowCount, 1);
  return {
    name: worksheet.name,
    usedRange: `A1:${columnLetters(lastColumn)}${lastRow}`,
    rows: worksheet.actualRowCount,
    columns: worksheet.actualColumnCount,
    populatedCells,
    numericCells,
    formulaCells,
    typeCounts,
    contentSha256: digest.digest("hex"),
  };
}

async function normalizeStructuredXlsxSource(sourcePath, normalizedRoot, sourceId, originalError) {
  const sourceRoot = path.join(normalizedRoot, sourceId);
  const inputDir = path.join(sourceRoot, "input");
  const outputDir = path.join(sourceRoot, "output");
  const profileDir = path.join(sourceRoot, "profile");
  await fs.rm(sourceRoot, { recursive: true, force: true });
  await Promise.all([
    fs.mkdir(inputDir, { recursive: true }),
    fs.mkdir(outputDir, { recursive: true }),
    fs.mkdir(profileDir, { recursive: true }),
  ]);
  const stagedInput = path.join(inputDir, "workbook.xlsx");
  await fs.copyFile(sourcePath, stagedInput);
  const conversion = await runLibreOffice([
    "--convert-to",
    "xlsx:Calc MS Excel 2007 XML",
    "--outdir",
    outputDir,
    stagedInput,
  ], profileDir);
  const derivedPath = path.join(outputDir, "workbook.xlsx");
  if (!(await pathExists(derivedPath))) {
    throw new Error(`ExcelJS could not read '${sourcePath}', and LibreOffice normalization did not produce an XLSX. ${conversion.stderr || conversion.stdout}`.trim());
  }
  const compatibilityNormalization = await normalizeLibreOfficeRoundTripPackage(derivedPath);
  const workbook = await loadXlsx(derivedPath);
  if (workbook.worksheets.length === 0) throw new Error(`Normalized source has no worksheets: ${sourcePath}`);
  return {
    workbook,
    path: derivedPath,
    normalization: {
      engine: "LibreOffice",
      reason: "exceljs-load-failed",
      originalError: originalError instanceof Error ? originalError.message : String(originalError),
      compatibilityNormalization,
    },
  };
}

async function captureSourceEvidence(sourcePaths, { normalizedRoot, forceNormalize = false } = {}) {
  const sources = [];
  for (const [index, sourcePathValue] of sourcePaths.entries()) {
    const originalPath = path.resolve(sourcePathValue);
    if (!(await pathExists(originalPath))) throw new Error(`Numeric-integrity source not found: ${originalPath}`);
    const extension = assertEvidenceSource(originalPath);
    const sourceId = `source-${index + 1}`;
    const originalSha256 = await fileSha256(originalPath);
    let effectivePath = originalPath;
    let effectiveSha256 = originalSha256;
    let structuredWorkbook = null;
    let normalization = null;
    if (extension === ".xlsx") {
      try {
        if (forceNormalize) throw new Error("Forced normalization for deterministic runtime self-test");
        structuredWorkbook = await loadXlsx(originalPath);
      } catch (error) {
        if (!normalizedRoot) throw error;
        const normalized = await normalizeStructuredXlsxSource(originalPath, normalizedRoot, sourceId, error);
        structuredWorkbook = normalized.workbook;
        effectivePath = normalized.path;
        effectiveSha256 = await fileSha256(effectivePath);
        normalization = { ...normalized.normalization, derivedPath: effectivePath, derivedSha256: effectiveSha256 };
      }
    }
    const source = {
      id: sourceId,
      path: effectivePath,
      sha256: effectiveSha256,
      format: extension.slice(1),
      origin: { path: originalPath, sha256: originalSha256, format: extension.slice(1) },
      ...(normalization ? { normalization } : {}),
    };
    if ([".xlsx", ".csv", ".tsv"].includes(extension)) {
      const workbook = structuredWorkbook ?? await loadDelimited(originalPath, { inferTypes: true });
      source.kind = "structured";
      source.sheets = workbook.worksheets.map(worksheetEvidenceSummary);
      source.summarySha256 = crypto.createHash("sha256").update(JSON.stringify(source.sheets)).digest("hex");
    } else {
      const metadata = await sharp(originalPath).metadata();
      source.kind = "image";
      source.image = {
        width: metadata.width ?? null,
        height: metadata.height ?? null,
        channels: metadata.channels ?? null,
        space: metadata.space ?? null,
        density: metadata.density ?? null,
      };
    }
    sources.push(source);
  }
  return {
    protocol: SOURCE_EVIDENCE_PROTOCOL,
    sources,
    imageFacts: [],
  };
}

function validateSourceEvidence(evidence, label = "source evidence") {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error(`${label} must be an object`);
  if (evidence.protocol !== SOURCE_EVIDENCE_PROTOCOL) throw new Error(`${label}.protocol must be '${SOURCE_EVIDENCE_PROTOCOL}'`);
  if (!Array.isArray(evidence.sources) || evidence.sources.length === 0) throw new Error(`${label}.sources must be a non-empty array`);
  if (!Array.isArray(evidence.imageFacts)) throw new Error(`${label}.imageFacts must be an array`);
  for (const [index, source] of evidence.sources.entries()) {
    if (!source || typeof source.path !== "string" || !path.isAbsolute(source.path) || !/^[a-f0-9]{64}$/i.test(String(source.sha256 ?? ""))) {
      throw new Error(`${label}.sources[${index}] requires an absolute path and SHA-256 hash`);
    }
    if (source.origin !== undefined && (!source.origin || typeof source.origin.path !== "string" || !path.isAbsolute(source.origin.path)
      || !/^[a-f0-9]{64}$/i.test(String(source.origin.sha256 ?? "")))) {
      throw new Error(`${label}.sources[${index}].origin requires an absolute path and SHA-256 hash`);
    }
    if (source.normalization !== undefined) {
      if (!source.origin || source.normalization.engine !== "LibreOffice" || source.normalization.reason !== "exceljs-load-failed"
        || !pathsReferToSameLocation(source.normalization.derivedPath, source.path)
        || source.normalization.derivedSha256 !== source.sha256) {
        throw new Error(`${label}.sources[${index}].normalization does not match the effective source`);
      }
    }
  }
  const sourcePaths = new Set(evidence.sources.map((source) => path.resolve(source.path)));
  const factIds = new Set();
  for (const [index, fact] of evidence.imageFacts.entries()) {
    const factLabel = `${label}.imageFacts[${index}]`;
    if (!fact || typeof fact.id !== "string" || fact.id.trim().length === 0) throw new Error(`${factLabel}.id must be a non-empty string`);
    if (factIds.has(fact.id)) throw new Error(`${factLabel}.id '${fact.id}' is duplicated`);
    factIds.add(fact.id);
    if (typeof fact.source !== "string" || !path.isAbsolute(fact.source) || !sourcePaths.has(path.resolve(fact.source))) {
      throw new Error(`${factLabel}.source must reference a frozen source image`);
    }
    if (!fact.region || !["x", "y", "width", "height"].every((key) => Number.isInteger(fact.region[key]) && fact.region[key] >= (key === "width" || key === "height" ? 1 : 0))) {
      throw new Error(`${factLabel}.region requires non-negative integer x/y and positive width/height`);
    }
    if (!/^[a-f0-9]{64}$/i.test(String(fact.regionSha256 ?? ""))) throw new Error(`${factLabel}.regionSha256 must be a SHA-256 hash`);
    if (!Array.isArray(fact.observations)) throw new Error(`${factLabel}.observations must be an array`);
    for (const [observationIndex, observation] of fact.observations.entries()) {
      if (!observation || typeof observation.method !== "string" || observation.method.trim().length === 0
        || typeof observation.rawText !== "string" || String(observation.normalizedValue ?? "").trim().length === 0
        || !Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1) {
        throw new Error(`${factLabel}.observations[${observationIndex}] requires method, rawText, normalizedValue, and confidence from 0 to 1`);
      }
    }
    if (fact.confirmation !== null && fact.confirmation !== undefined) {
      if (fact.confirmation.status !== "confirmed" || fact.confirmation.confirmedBy !== "user"
        || fact.confirmation.basis !== "explicit-user" || String(fact.confirmation.value ?? "").trim().length === 0) {
        throw new Error(`${factLabel}.confirmation must record an explicit user-confirmed value`);
      }
    }
  }
  return evidence;
}

function parseImageRegion(value) {
  const parts = String(value).split(",").map((item) => Number.parseInt(item.trim(), 10));
  if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item))) throw new Error("--region must be x,y,width,height integers");
  const [x, y, width, height] = parts;
  if (x < 0 || y < 0 || width < 1 || height < 1) throw new Error("--region must use non-negative x/y and positive width/height");
  return { x, y, width, height };
}

async function imageRegionSha256(sourcePath, region) {
  const metadata = await sharp(sourcePath).metadata();
  if (!metadata.width || !metadata.height || region.x + region.width > metadata.width || region.y + region.height > metadata.height) {
    throw new Error(`Image region exceeds ${metadata.width ?? "?"}x${metadata.height ?? "?"} source bounds`);
  }
  const buffer = await sharp(sourcePath)
    .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
    .png()
    .toBuffer();
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function commandEvidenceObserve(options) {
  const evidencePath = assertInternalArtifactPath(requireOption(options, "evidence"), "Spreadsheet source evidence");
  const evidence = validateSourceEvidence(await readJsonFile(evidencePath, "Spreadsheet source evidence"));
  const sourcePath = path.resolve(requireOption(options, "source"));
  const source = evidence.sources.find((item) => pathsReferToSameLocation(item.path, sourcePath));
  if (!source || source.kind !== "image") throw new Error(`Evidence source is not a frozen image: ${sourcePath}`);
  if (await fileSha256(sourcePath) !== source.sha256.toLowerCase()) throw new Error(`Source image changed after prepare: ${sourcePath}`);
  const factId = requireOption(options, "fact-id").trim();
  const method = requireOption(options, "method").trim();
  const rawText = requireOption(options, "raw-text");
  const normalizedValue = requireOption(options, "value").trim();
  const confidence = Number(requireOption(options, "confidence"));
  if (!factId || !method || !normalizedValue) throw new Error("--fact-id, --method, and --value must be non-empty");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("--confidence must be between 0 and 1");
  const region = parseImageRegion(requireOption(options, "region"));
  const regionSha256 = await imageRegionSha256(sourcePath, region);
  let fact = evidence.imageFacts.find((item) => item.id === factId);
  if (!fact) {
    fact = { id: factId, source: sourcePath, region, regionSha256, observations: [], confirmation: null };
    evidence.imageFacts.push(fact);
  } else if (!pathsReferToSameLocation(fact.source, sourcePath)
    || JSON.stringify(fact.region) !== JSON.stringify(region)
    || fact.regionSha256 !== regionSha256) {
    throw new Error(`Image fact '${factId}' is already bound to a different source region`);
  }
  const methodIndex = fact.observations.findIndex((item) => item.method.trim().toLowerCase() === method.toLowerCase());
  const observation = { method, rawText, normalizedValue, confidence };
  if (methodIndex >= 0) {
    if (!options.overwrite) throw new Error(`Image fact '${factId}' already has an observation from method '${method}'`);
    fact.observations[methodIndex] = observation;
  } else {
    fact.observations.push(observation);
  }
  fact.confirmation = null;
  validateSourceEvidence(evidence);
  await writeJson(evidencePath, evidence);
  const report = { status: "ok", evidence: evidencePath, fact };
  if (!options.quiet) await emitReport(report, options.report && String(options.report));
  else if (options.report) await writeJson(String(options.report), report);
}

async function commandEvidenceConfirm(options) {
  const evidencePath = assertInternalArtifactPath(requireOption(options, "evidence"), "Spreadsheet source evidence");
  const evidence = validateSourceEvidence(await readJsonFile(evidencePath, "Spreadsheet source evidence"));
  const factId = requireOption(options, "fact-id").trim();
  const value = requireOption(options, "value").trim();
  const confirmedBy = requireOption(options, "confirmed-by").trim().toLowerCase();
  if (confirmedBy !== "user") throw new Error("--confirmed-by must be user and may only be used after explicit user confirmation");
  const fact = evidence.imageFacts.find((item) => item.id === factId);
  if (!fact) throw new Error(`Image fact not found: ${factId}`);
  if (!value) throw new Error("--value must be non-empty");
  fact.confirmation = { status: "confirmed", value, confirmedBy: "user", basis: "explicit-user" };
  validateSourceEvidence(evidence);
  await writeJson(evidencePath, evidence);
  const report = { status: "ok", evidence: evidencePath, factId, confirmation: fact.confirmation };
  if (!options.quiet) await emitReport(report, options.report && String(options.report));
  else if (options.report) await writeJson(String(options.report), report);
}

function numericIntegrityPlanTemplate() {
  return {
    protocol: NUMERIC_INTEGRITY_PROTOCOL,
    mode: "strict",
    operations: [],
    invariants: [],
  };
}

function scaffoldSourceRegion(source, fields) {
  const sheet = source.sheets?.[0];
  if (!sheet) throw new Error(`Structured source has no worksheet evidence: ${source.path}`);
  const bounds = parseRangeReference(sheet.usedRange);
  const startRow = bounds.endRow >= 2 ? 2 : 1;
  const availableColumns = Math.max(1, bounds.endCol);
  const columns = {};
  for (const [index, field] of fields.entries()) columns[field] = columnLetters(Math.min(index + 1, availableColumns));
  return {
    source: source.path,
    sheet: sheet.name,
    range: `A${startRow}:${columnLetters(bounds.endCol)}${bounds.endRow}`,
    columns,
  };
}

function operationReferenceRegion(operation) {
  return {
    operation: operation.id,
    sheet: operation.output.sheet,
    range: operation.output.range,
    columns: { ...operation.output.columns },
  };
}

function uniqueFieldName(fields, preferred) {
  if (!Object.hasOwn(fields, preferred)) return preferred;
  let suffix = 2;
  while (Object.hasOwn(fields, `${preferred}${suffix}`)) suffix += 1;
  return `${preferred}${suffix}`;
}

function expandedOutputRegion(region, addedFields) {
  const bounds = parseRangeReference(region.range);
  const columns = { ...region.columns };
  let column = bounds.endCol;
  for (const field of addedFields) {
    column += 1;
    columns[field] = columnLetters(column);
  }
  return {
    sheet: region.sheet,
    range: `${columnLetters(bounds.startCol)}${bounds.startRow}:${columnLetters(column)}${bounds.endRow}`,
    columns,
  };
}

function integrityScaffoldPlan(evidence, operationType, {
  sourceIds = [],
  priorPlan = null,
  fromOperation = null,
  operationId = null,
} = {}) {
  const allStructured = evidence.sources.filter((source) => source.kind === "structured");
  const sourceIdSet = new Set(sourceIds);
  const structured = sourceIds.length > 0
    ? allStructured.filter((source) => sourceIdSet.has(source.id))
    : allStructured;
  const missingSourceIds = sourceIds.filter((sourceId) => !structured.some((source) => source.id === sourceId));
  if (missingSourceIds.length > 0) throw new Error(`Unknown or non-structured --source-id value(s): ${missingSourceIds.join(", ")}`);
  const images = evidence.sources.filter((source) => source.kind === "image");
  const outputSheet = "REPLACE_WITH_OUTPUT_SHEET";
  const draft = priorPlan
    ? structuredClone(priorPlan)
    : { protocol: NUMERIC_INTEGRITY_PROTOCOL, mode: "strict", draft: true, operations: [], invariants: [] };
  draft.draft = true;
  const dependency = fromOperation
    ? draft.operations.find((operation) => operation.id === fromOperation)
    : null;
  if (fromOperation && !dependency) throw new Error(`--from-operation references missing operation '${fromOperation}'`);
  const id = operationId ?? `${operationType}-${draft.operations.length + 1}`;
  if (draft.operations.some((operation) => operation.id === id)) throw new Error(`Integrity operation id '${id}' already exists`);
  if (operationType === "ocr") {
    if (images.length === 0) {
      throw blocked("integrity-scaffold-no-image-source", "The OCR scaffold needs an image source frozen by prepare", {
        next: "Rerun prepare with every source image that provides numeric facts.",
      });
    }
    draft.operations.push({
      id,
      type: "ocr",
      fields: { value: { semanticType: "decimal", scale: 2, allowBlank: false } },
      output: { sheet: outputSheet },
      facts: evidence.imageFacts.length > 0
        ? evidence.imageFacts.map((fact, index) => ({ evidenceId: fact.id, cell: `A${index + 2}`, field: "value" }))
        : [{ evidenceId: "REPLACE_WITH_EVIDENCE_ID", cell: "A2", field: "value" }],
    });
    draft.ocrPolicy = { minConfidence: 0.9, minIndependentObservations: 2, allowExplicitUserConfirmation: true };
    return draft;
  }
  if (!dependency && structured.length === 0) throw blocked("integrity-scaffold-no-structured-source", "The requested operation needs at least one structured source frozen by prepare");
  if (dependency && ["copy", "union", "ocr"].includes(operationType)) throw new Error(`--from-operation is not supported for ${operationType}`);
  const sourceCount = operationType === "join"
    ? (dependency ? 1 : 2)
    : operationType === "union"
      ? structured.length
      : dependency
        ? 0
        : 1;
  if (structured.length < sourceCount) {
    throw blocked("integrity-scaffold-insufficient-sources", `The '${operationType}' scaffold needs at least ${sourceCount} structured sources`, {
      available: structured.length,
      next: "Rerun prepare with every fact-providing source file.",
    });
  }
  if (["copy", "union", "join"].includes(operationType)) {
    const baseFields = dependency ? structuredClone(dependency.fields) : {
      recordId: { semanticType: "identifier" },
      value: { semanticType: "string", allowBlank: true },
    };
    const keyField = dependency?.keyColumns?.[0] ?? Object.keys(baseFields)[0];
    const lookupField = uniqueFieldName(baseFields, "lookupValue");
    const fields = operationType === "join" && dependency
      ? { ...baseFields, [lookupField]: { semanticType: "string", allowBlank: true } }
      : baseFields;
    const sourceFieldNames = operationType === "join" && dependency ? [keyField, lookupField] : Object.keys(fields);
    const sourceInputs = structured.slice(0, sourceCount).map((source) => scaffoldSourceRegion(source, sourceFieldNames));
    const inputs = dependency ? [operationReferenceRegion(dependency), ...sourceInputs] : sourceInputs;
    const rowCount = operationType === "union"
      ? inputs.reduce((total, input) => total + Math.max(0, parseRangeReference(input.range).endRow - parseRangeReference(input.range).startRow + 1), 0)
      : Math.max(1, parseRangeReference(inputs[0].range).endRow - parseRangeReference(inputs[0].range).startRow + 1);
    const output = dependency && operationType === "join"
      ? expandedOutputRegion(dependency.output, [lookupField])
      : { sheet: outputSheet, range: `A2:${columnLetters(Object.keys(fields).length)}${rowCount + 1}`, columns: Object.fromEntries(Object.keys(fields).map((field, index) => [field, columnLetters(index + 1)])) };
    draft.operations.push({
      id,
      type: operationType,
      fields,
      inputs,
      output,
      keyColumns: [keyField],
      duplicatePolicy: "error",
      ...(operationType === "join" ? { missingMatchPolicy: "error" } : {}),
      ...(operationType === "union" ? { preserveOrder: true } : {}),
    });
  } else if (operationType === "aggregate") {
    const dependencyFields = dependency ? structuredClone(dependency.fields) : null;
    const dependencyFieldNames = dependencyFields ? Object.keys(dependencyFields) : [];
    const value = dependency
      ? dependencyFieldNames.find((field) => ["decimal", "integer", "number"].includes(dependencyFields[field].semanticType))
      : "value";
    if (dependency && !value) {
      throw blocked("integrity-scaffold-no-numeric-field", `Operation '${dependency.id}' has no numeric field to aggregate`, {
        next: "Correct the prior operation's field semantics or append a formula operation that produces a numeric field.",
      });
    }
    const group = dependency
      ? dependencyFieldNames.find((field) => field !== value && ["identifier", "string"].includes(dependencyFields[field].semanticType))
        ?? dependencyFieldNames.find((field) => field !== value)
      : "group";
    if (dependency && !group) {
      throw blocked("integrity-scaffold-no-group-field", `Operation '${dependency.id}' has no field distinct from '${value}' to group by`, {
        next: "Correct the prior operation's fields so the aggregate has both a grouping field and a numeric measure.",
      });
    }
    const total = uniqueFieldName(dependencyFields ?? {}, "total");
    const input = dependency
      ? { ...operationReferenceRegion(dependency), columns: { [group]: dependency.output.columns[group], [value]: dependency.output.columns[value] } }
      : scaffoldSourceRegion(structured[0], [group, value]);
    draft.operations.push({
      id,
      type: "aggregate",
      fields: {
        [group]: dependencyFields?.[group] ?? { semanticType: "string" },
        [value]: dependencyFields?.[value] ?? { semanticType: "decimal", scale: 2 },
        [total]: { semanticType: "decimal", scale: 2 },
      },
      inputs: [input],
      output: { sheet: outputSheet, range: "A2:B2", columns: { [group]: "A", [total]: "B" } },
      groupBy: [group],
      measures: [{ source: value, target: total, operator: "sum", rounding: "half-up" }],
    });
  } else if (operationType === "formula") {
    const dependencyFields = dependency ? structuredClone(dependency.fields) : null;
    const result = uniqueFieldName(dependencyFields ?? {}, "calculatedValue");
    const input = dependency ? operationReferenceRegion(dependency) : scaffoldSourceRegion(structured[0], ["input"]);
    const rows = Math.max(1, parseRangeReference(input.range).endRow - parseRangeReference(input.range).startRow + 1);
    const fields = dependencyFields ?? { input: { semanticType: "decimal", scale: 2 } };
    fields[result] = { semanticType: "decimal", scale: 2 };
    const output = dependency
      ? expandedOutputRegion(dependency.output, [result])
      : { sheet: outputSheet, range: `A2:B${rows + 1}`, columns: { input: "A", [result]: "B" } };
    draft.operations.push({
      id,
      type: "formula",
      fields,
      inputs: [input],
      output,
      calculations: [{ target: result, expression: "REPLACE_WITH_EXPRESSION", rounding: "half-up", requireFormula: true }],
    });
  } else {
    throw new Error(`--operation must be one of copy, union, join, aggregate, formula, ocr`);
  }
  return draft;
}

async function commandIntegrityScaffold(options) {
  const requirementsPath = assertInternalArtifactPath(requireOption(options, "requirements"), "Spreadsheet requirements");
  const requirements = await readJsonFile(requirementsPath, "Spreadsheet requirements");
  validateRequirements(requirements, requirementsPath);
  if (!requirements.numericIntegrity) throw new Error("Requirements were not prepared with --source");
  const evidencePath = assertInternalArtifactPath(requirements.numericIntegrity.evidence.path, "Spreadsheet source evidence");
  const planPath = assertInternalArtifactPath(requirements.numericIntegrity.plan.path, "Spreadsheet numeric-integrity plan");
  const evidence = validateSourceEvidence(await readJsonFile(evidencePath, "Spreadsheet source evidence"));
  let existingPlan = null;
  if (await pathExists(planPath)) {
    const existing = await readJsonFile(planPath, "Spreadsheet numeric-integrity plan");
    const generatedBlank = existing.protocol === NUMERIC_INTEGRITY_PROTOCOL
      && existing.mode === "strict"
      && Array.isArray(existing.operations) && existing.operations.length === 0;
    if (options.append) {
      if (generatedBlank) existingPlan = existing;
      else if (existing.protocol === NUMERIC_INTEGRITY_PROTOCOL && Array.isArray(existing.operations)) existingPlan = existing;
      else throw new Error(`Invalid existing numeric-integrity plan: ${planPath}`);
    } else if (!generatedBlank && !options.overwrite) {
      throw blocked("integrity-plan-exists", "Refusing to replace a non-empty numeric-integrity plan", {
        plan: planPath,
        next: "Use --append to add a dependent operation, or --overwrite only after reviewing the existing plan.",
      });
    }
  }
  const operation = requireOption(options, "operation").trim().toLowerCase();
  const plan = integrityScaffoldPlan(evidence, operation, {
    sourceIds: optionValues(options, "source-id"),
    priorPlan: existingPlan,
    fromOperation: options["from-operation"] ? requireOption(options, "from-operation") : null,
    operationId: options.id ? requireOption(options, "id") : null,
  });
  await writeJson(planPath, plan);
  const report = {
    status: "ok",
    plan: planPath,
    operation: plan.operations.at(-1).id,
    operationType: operation,
    operationCount: plan.operations.length,
    draft: true,
    frozenSources: evidence.sources.map((source) => ({ id: source.id, path: source.path, origin: source.origin?.path ?? source.path, sheets: source.sheets?.map((sheet) => ({ name: sheet.name, usedRange: sheet.usedRange })) ?? [] })),
    next: "Use --append with --from-operation for the next dependent step, or edit only field semantics, exact ranges/columns, output mappings, keys, and operation rules. Then set draft=false and run integrity-status before integrity-bind.",
  };
  if (!options.quiet) await emitReport(report, options.report && String(options.report));
  else if (options.report) await writeJson(String(options.report), report);
  return report;
}

function columnNumberFromLetters(value) {
  const letters = String(value).trim().toUpperCase();
  if (!/^[A-Z]+$/.test(letters)) throw new Error(`Invalid Excel column '${value}'`);
  let result = 0;
  for (const character of letters) result = result * 26 + character.charCodeAt(0) - 64;
  return result;
}

function rowsFromWorkbookRegion(workbook, region) {
  const worksheet = workbook.getWorksheet(region.sheet);
  if (!worksheet) throw new Error(`Worksheet not found: ${region.sheet}`);
  const bounds = parseRangeReference(region.range);
  const columns = Object.fromEntries(Object.entries(region.columns).map(([field, column]) => [field, columnNumberFromLetters(column)]));
  for (const [field, column] of Object.entries(columns)) {
    if (column < bounds.startCol || column > bounds.endCol) {
      throw new Error(`${region.sheet}!${region.range} does not contain mapped column ${region.columns[field]} for '${field}'`);
    }
  }
  const rows = [];
  for (let rowNumber = bounds.startRow; rowNumber <= bounds.endRow; rowNumber += 1) {
    const values = {};
    let populated = false;
    for (const [field, column] of Object.entries(columns)) {
      const cell = worksheet.getCell(rowNumber, column);
      const value = effectiveCellValue(cell);
      if (hasCellContent(value)) populated = true;
      values[field] = {
        value,
        type: cellValueType(cell),
        address: cell.address,
        formula: formulaDescriptor(cell)?.formula ?? null,
        numberFormat: cell.numFmt ?? null,
      };
    }
    if (populated || region.skipBlankRows === false) rows.push({ row: rowNumber, values });
  }
  return rows;
}

async function evaluateBoundNumericIntegrity(candidateWorkbook, requirements) {
  const binding = requirements?.numericIntegrity;
  if (!binding) return { status: "not_requested", protocol: NUMERIC_INTEGRITY_PROTOCOL, checks: [], operations: [], failures: [] };
  const failures = [];
  const checks = [];
  const record = (type, passed, details = {}) => {
    const check = { type, passed, ...details };
    checks.push(check);
    if (!passed) failures.push(check);
  };
  if (binding.state !== "bound") {
    record("integrity_binding", false, { expected: "bound", actual: binding.state });
    return { status: "failed", protocol: NUMERIC_INTEGRITY_PROTOCOL, checks, operations: [], failures };
  }
  try {
    const evidencePath = assertInternalArtifactPath(binding.evidence.path, "Spreadsheet source evidence");
    const planPath = assertInternalArtifactPath(binding.plan.path, "Spreadsheet numeric-integrity plan");
    const [evidenceHash, planHash] = await Promise.all([fileSha256(evidencePath), fileSha256(planPath)]);
    record("evidence_binding", evidenceHash === binding.evidence.sha256.toLowerCase(), { expected: binding.evidence.sha256.toLowerCase(), actual: evidenceHash, path: evidencePath });
    record("plan_binding", planHash === binding.plan.sha256.toLowerCase(), { expected: binding.plan.sha256.toLowerCase(), actual: planHash, path: planPath });
    if (failures.length > 0) return { status: "failed", protocol: NUMERIC_INTEGRITY_PROTOCOL, checks, operations: [], failures };
    const evidence = validateSourceEvidence(await readJsonFile(evidencePath, "Spreadsheet source evidence"));
    const plan = validateNumericIntegrityPlan(await readJsonFile(planPath, "Spreadsheet numeric-integrity plan"));
    const expectedSources = new Map((requirements.sourceFiles ?? []).map((item) => [path.resolve(item.path), item.sha256.toLowerCase()]));
    const evidenceSources = new Map(evidence.sources.map((item) => [path.resolve(item.path), item.sha256.toLowerCase()]));
    for (const [sourcePath, expectedHash] of expectedSources.entries()) {
      record("evidence_source_coverage", evidenceSources.get(sourcePath) === expectedHash, { path: sourcePath, expectedSha256: expectedHash, evidenceSha256: evidenceSources.get(sourcePath) ?? null });
    }
    for (const fact of evidence.imageFacts) {
      const actualRegionSha256 = await imageRegionSha256(fact.source, fact.region);
      record("image_region_binding", actualRegionSha256 === fact.regionSha256.toLowerCase(), {
        evidenceId: fact.id,
        source: fact.source,
        region: fact.region,
        expectedSha256: fact.regionSha256.toLowerCase(),
        actualSha256: actualRegionSha256,
      });
    }
    const usedSources = planSourcePaths(plan);
    for (const sourcePath of usedSources) {
      record("plan_source_frozen", expectedSources.has(sourcePath), { path: sourcePath });
    }
    const sourceCache = new Map();
    const loadStructuredSource = async (sourcePath) => {
      const resolved = path.resolve(sourcePath);
      if (!sourceCache.has(resolved)) {
        const extension = assertEvidenceSource(resolved);
        if (![".xlsx", ".csv", ".tsv"].includes(extension)) throw new Error(`Structured operation cannot read image source: ${resolved}`);
        sourceCache.set(resolved, extension === ".xlsx" ? await loadXlsx(resolved) : await loadDelimited(resolved, { inferTypes: true }));
      }
      return sourceCache.get(resolved);
    };
    const evaluation = await evaluateNumericIntegrityPlan(plan, {
      readSourceRows: async (region) => rowsFromWorkbookRegion(await loadStructuredSource(region.source), region),
      readCandidateRows: async (region) => rowsFromWorkbookRegion(candidateWorkbook, region),
      readImageFact: async (evidenceId) => evidence.imageFacts.find((fact) => fact.id === evidenceId) ?? null,
      readCandidateCell: async (sheetName, address) => {
        const cell = candidateWorkbook.getWorksheet(sheetName)?.getCell(address);
        if (!cell) throw new Error(`Candidate cell not found: ${sheetName}!${address}`);
        return {
          value: effectiveCellValue(cell),
          type: cellValueType(cell),
          address: cell.address,
          formula: formulaDescriptor(cell)?.formula ?? null,
          numberFormat: cell.numFmt ?? null,
        };
      },
    });
    for (const operation of evaluation.operations) {
      record("numeric_operation", operation.status === "passed", {
        operation: operation.id,
        operationType: operation.type,
        sourceRecords: operation.sourceRecords,
        expectedOutputRecords: operation.expectedOutputRecords,
        outputRecords: operation.outputRecords,
        failures: operation.failures,
      });
    }
    for (const invariant of evaluation.invariants?.checks ?? []) {
      record("numeric_invariant", invariant.passed, {
        invariant: invariant.invariant,
        operation: invariant.operation,
        expression: invariant.expression,
        expected: invariant.expected,
        checkedRows: invariant.checkedRows,
        mismatches: invariant.mismatches,
      });
    }
    return {
      status: failures.length === 0 && evaluation.status === "passed" ? "passed" : "failed",
      protocol: NUMERIC_INTEGRITY_PROTOCOL,
      checks,
      operations: evaluation.operations,
      failures,
      evidence: { path: evidencePath, sha256: evidenceHash },
      plan: { path: planPath, sha256: planHash },
    };
  } catch (error) {
    record("numeric_integrity_runtime", false, { error: error instanceof Error ? error.message : String(error) });
    return { status: "failed", protocol: NUMERIC_INTEGRITY_PROTOCOL, checks, operations: [], failures };
  }
}

function assertNumericIntegrityBound(requirements) {
  if (requirements?.numericIntegrity && requirements.numericIntegrity.state !== "bound") {
    throw blocked(
      "numeric-integrity-unbound",
      "Source-backed numeric integrity must be bound before build",
      { next: "Complete integrity-plan.json, then run integrity-bind." },
    );
  }
}

async function persistNumericIntegrityReport(requirements, report) {
  if (!requirements?.numericIntegrity || !report || report.status === "not_requested") return null;
  const target = assertInternalArtifactPath(
    path.join(path.dirname(requirements.numericIntegrity.evidence.path), "numeric-integrity.json"),
    "Spreadsheet numeric-integrity report",
  );
  await writeJson(target, report);
  return target;
}

async function evaluateTaskFiles(requirements) {
  const checks = [];
  for (const [type, item] of [
    ["task_input_integrity", requirements?.task?.input],
    ["style_source_integrity", requirements?.task?.styleSource],
  ]) {
    if (!item) continue;
    const exists = await pathExists(item.path);
    const actual = exists ? await fileSha256(item.path) : null;
    checks.push({
      type,
      passed: exists && actual === String(item.sha256).toLowerCase(),
      path: item.path,
      expectedSha256: String(item.sha256).toLowerCase(),
      actualSha256: actual,
    });
  }
  return checks;
}

function cellDisplayValueForAudit(cell) {
  const formula = formulaDescriptor(cell);
  if (formula) return formula.result;
  if (cell.value instanceof Date) return safeDateIso(cell.value) ?? "<Invalid Date>";
  if (cell.value && typeof cell.value === "object") {
    if (typeof cell.value.text === "string") return cell.value.text;
    if (Array.isArray(cell.value.richText)) return cell.value.richText.map((run) => run.text ?? "").join("");
    if (typeof cell.value.error === "string") return cell.value.error;
  }
  return cell.value;
}

function evaluateWarningDispositions(warnings, requirements) {
  if (warnings.length === 0) return { status: "not_needed", total: 0, disposed: 0, dispositions: [], unresolved: [] };
  const declared = Array.isArray(requirements?.warningDispositions) ? requirements.warningDispositions : [];
  const dispositions = [];
  const unresolved = [];
  for (const warning of warnings) {
    const disposition = declared.find((item) => item?.type === warning.type && typeof item.rationale === "string" && item.rationale.trim().length > 0);
    if (disposition) dispositions.push({ warning, rationale: disposition.rationale.trim() });
    else unresolved.push(warning);
  }
  return {
    status: unresolved.length === 0 ? "passed" : "failed",
    total: warnings.length,
    disposed: dispositions.length,
    dispositions,
    unresolved,
  };
}

function collectCjkFontWarnings(workbook) {
  const warnings = [];
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = displayCellText(cell);
        if (!CJK_TEXT_PATTERN.test(text)) return;
        const name = cell.font?.name;
        if (name && LATIN_ONLY_CJK_FONTS.has(name.toLowerCase()) && warnings.length < 100) {
          warnings.push({ sheet: worksheet.name, address: cell.address, font: name });
        }
      });
    });
  }
  return warnings;
}

function cellFillArgb(cell) {
  const fill = cell.fill;
  if (!fill || fill.type !== "pattern" || fill.pattern !== "solid") return null;
  const color = fill.fgColor?.argb;
  return typeof color === "string" && /^[A-F0-9]{8}$/i.test(color) ? color.toUpperCase() : null;
}

function isLightNeutralArgb(color) {
  if (!/^[A-F0-9]{8}$/i.test(String(color ?? ""))) return false;
  const red = Number.parseInt(color.slice(2, 4), 16);
  const green = Number.parseInt(color.slice(4, 6), 16);
  const blue = Number.parseInt(color.slice(6, 8), 16);
  return Math.min(red, green, blue) >= 200 && Math.max(red, green, blue) - Math.min(red, green, blue) <= 12;
}

function collectStylePolicyFailures(workbook, requirements) {
  const task = requirements?.task;
  if (!task || task.styleMode !== "neutral-built-in") return [];
  const failures = [];
  const neutralColors = new Set([
    "FFFFFFFF", "FFF9FAFB", "FFF8FAFC", "FFF3F4F6", "FFF1F5F9",
    "FFE5E7EB", "FFE2E8F0", "FFD1D5DB", "FFCBD5E1",
  ]);
  const semanticColors = {
    tracker: ["FFDCFCE7", "FFFEF3C7", "FFFEE2E2"],
    model: ["FFFFF7D6", "FFECFDF5"],
  };
  for (const color of semanticColors[task.workbookType] ?? []) neutralColors.add(color);
  for (const color of task.allowedAccentColors ?? []) neutralColors.add(String(color).toUpperCase());

  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const fill = cellFillArgb(cell);
        if (fill && !neutralColors.has(fill) && !isLightNeutralArgb(fill) && failures.length < 100) {
          failures.push({
            type: "unrequested_chromatic_fill",
            sheet: worksheet.name,
            address: cell.address,
            color: fill,
          });
        }
        const fontSize = Number(cell.font?.size ?? 0);
        if (
          !task.allowDecorativeTitle
          && ["data", "tracker", "model"].includes(task.workbookType)
          && rowNumber <= 5
          && displayCellText(cell).trim()
          && fontSize > 14
          && failures.length < 100
        ) {
          failures.push({
            type: "unrequested_oversized_title",
            sheet: worksheet.name,
            address: cell.address,
            fontSize,
          });
        }
      });
    });
    for (const table of worksheet.model?.tables ?? []) {
      const theme = table.style?.theme ?? table.tableStyleInfo?.name ?? null;
      if (typeof theme === "string" && !/^TableStyleLight1$/i.test(theme)) {
        failures.push({ type: "unrequested_colored_table_style", sheet: worksheet.name, table: table.name ?? null, theme });
      }
    }
  }
  return failures;
}

function chartRangeDetails(workbook, formula) {
  const match = /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(String(formula ?? "").replaceAll("$", ""));
  if (!match) return null;
  const sheetName = match[1]?.replaceAll("''", "'") ?? match[2];
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) return null;
  try {
    const range = parseRangeReference(match[3]);
    const values = [];
    for (let row = range.startRow; row <= range.endRow; row += 1) {
      for (let column = range.startCol; column <= range.endCol; column += 1) {
        values.push(effectiveCellValue(worksheet.getCell(row, column)));
      }
    }
    return { count: values.length, values };
  } catch {
    return null;
  }
}

function chartPointStats(workbook, series) {
  const categories = chartRangeDetails(workbook, series.categories);
  const values = chartRangeDetails(workbook, series.values);
  if (!categories || !values) return null;
  const blankCategories = categories.values.filter((value) => value === null || value === undefined || String(value).trim() === "").length;
  const blankValues = values.values.filter((value) => value === null || value === undefined || String(value).trim() === "").length;
  const numericValues = values.values.filter((value) => value !== null && value !== undefined && String(value).trim() !== "" && Number.isFinite(Number(value))).length;
  return { categories: categories.count, values: values.count, blankCategories, blankValues, numericValues };
}

function collectChartFailures(workbook, packageInfo) {
  const failures = [];
  for (const chart of packageInfo.charts) {
    if (!chart.sheet) failures.push({ type: "unmapped_native_chart", chart: chart.part });
    for (const series of chart.series ?? []) {
      if (!series.categories || !series.values) continue;
      const stats = chartPointStats(workbook, series);
      if (!stats) {
        failures.push({ type: "invalid_chart_source_range", chart: chart.part, series: series.index, categories: series.categories, values: series.values });
      } else if (stats.categories !== stats.values) {
        failures.push({ type: "chart_series_length_mismatch", chart: chart.part, series: series.index, categories: stats.categories, values: stats.values });
      } else if (stats.blankCategories > 0) {
        failures.push({ type: "chart_blank_categories", chart: chart.part, series: series.index, blank: stats.blankCategories, total: stats.categories });
      } else if (stats.blankValues > 0 || stats.numericValues !== stats.values) {
        failures.push({ type: "chart_invalid_values", chart: chart.part, series: series.index, blank: stats.blankValues, numeric: stats.numericValues, total: stats.values });
      } else if (chart.types.includes("line") && stats.values < 2) {
        failures.push({ type: "chart_insufficient_points", chart: chart.part, series: series.index, minimum: 2, actual: stats.values });
      }
    }
  }
  return failures;
}

async function auditXlsx(filePath, requirements = null) {
  const packageInfo = await inspectPackage(filePath);
  const workbook = await loadXlsx(filePath);
  const facts = collectWorkbookFacts(workbook);
  const coverage = evaluateRequirements(workbook, packageInfo, requirements);
  const numericIntegrity = await evaluateBoundNumericIntegrity(workbook, requirements);
  if (numericIntegrity.status !== "not_requested") {
    const check = {
      type: "numeric_integrity",
      passed: numericIntegrity.status === "passed",
      expected: "passed",
      actual: numericIntegrity.status,
      failures: numericIntegrity.failures,
    };
    coverage.checks.push(check);
    if (!check.passed) coverage.failures.push(check);
    coverage.total = coverage.checks.length;
    coverage.passed = coverage.checks.filter((item) => item.passed).length;
    coverage.status = coverage.failures.length === 0 ? "passed" : "failed";
  }
  const sourceFileChecks = await evaluateSourceFiles(requirements);
  const taskFileChecks = await evaluateTaskFiles(requirements);
  const fileChecks = [...sourceFileChecks, ...taskFileChecks];
  if (fileChecks.length > 0) {
    coverage.checks.push(...fileChecks);
    coverage.failures.push(...fileChecks.filter((check) => !check.passed));
    coverage.total = coverage.checks.length;
    coverage.passed = coverage.checks.filter((check) => check.passed).length;
    coverage.status = coverage.failures.length === 0 ? "passed" : "failed";
  }
  const cjkFontWarnings = collectCjkFontWarnings(workbook);
  const chartFailures = collectChartFailures(workbook, packageInfo);
  const stylePolicyFailures = collectStylePolicyFailures(workbook, requirements);
  const dataPreservationFailures = [];
  let dataPreservation = { status: "not_requested" };
  if (requirements?.task?.dataOperation === "presentation-only" && requirements.task.input?.path) {
    const inputWorkbook = await loadXlsx(requirements.task.input.path);
    const expected = workbookDataFingerprint(inputWorkbook);
    const actual = workbookDataFingerprint(workbook);
    const passed = expected === actual;
    dataPreservation = { status: passed ? "passed" : "failed", expected, actual };
    if (!passed) dataPreservationFailures.push({ type: "presentation_only_data_changed", expected, actual });
  }
  const blankSheets = workbook.worksheets
    .filter((worksheet) => worksheet.actualRowCount === 0)
    .map((worksheet) => worksheet.name);
  const oversizedSheets = workbook.worksheets
    .filter((worksheet) => worksheet.rowCount > 200000 || worksheet.columnCount > 200)
    .map((worksheet) => ({ name: worksheet.name, rows: worksheet.rowCount, columns: worksheet.columnCount }));
  const warnings = [];
  const advisories = [];
  if (blankSheets.length > 0) warnings.push({ type: "blank_sheets", sheets: blankSheets });
  if (oversizedSheets.length > 0) warnings.push({ type: "large_used_ranges", sheets: oversizedSheets });
  if (facts.missingCachedResults.length > 0) {
    warnings.push({ type: "missing_cached_formula_results", cells: facts.missingCachedResults.slice(0, 100) });
  }
  if (packageInfo.unsafeForRoundTrip) {
    advisories.push({ type: "future_round_trip_risk", features: packageInfo.roundTripRisks });
  }
  if (cjkFontWarnings.length > 0) warnings.push({ type: "cjk_font_fallback", cells: cjkFontWarnings });
  const warningDispositions = evaluateWarningDispositions(warnings, requirements);
  const hardFailures = [
    ...facts.errors.map((error) => ({ type: "formula_error", ...error })),
    ...facts.missingCachedResults.map((error) => ({ type: "missing_cached_formula_result", ...error })),
    ...facts.formulaReferencesWithErrors.map((error) => ({ type: "invalid_formula_reference", ...error })),
    ...facts.invalidDates.map((error) => ({ type: "invalid_date_value", ...error })),
    ...chartFailures,
    ...stylePolicyFailures,
    ...dataPreservationFailures,
    ...packageInfo.compatibility.issues,
    ...numericIntegrity.failures.map((failure) => ({ ...failure, reason: failure.type, type: "numeric_integrity_failure" })),
    ...coverage.failures.map((failure) => ({ type: "requirement_not_met", requirement: failure })),
  ];
  return {
    status: hardFailures.length > 0 ? "error" : warnings.length > 0 && warningDispositions.status === "failed" ? "partial" : "ok",
    path: path.resolve(filePath),
    worksheetCount: workbook.worksheets.length,
    formulas: {
      count: facts.formulaCount,
      errors: facts.errors,
      missingCachedResults: facts.missingCachedResults,
      invalidReferences: facts.formulaReferencesWithErrors,
    },
    invalidDates: facts.invalidDates,
    package: packageInfo,
    stylePolicy: {
      mode: requirements?.task?.styleMode ?? "not_declared",
      workbookType: requirements?.task?.workbookType ?? null,
      failures: stylePolicyFailures,
    },
    dataPreservation,
    numericIntegrity,
    coverage,
    hardFailures,
    warnings,
    warningDispositions,
    advisories,
  };
}

function failureCategory(failure) {
  if (failure.type === "requirement_not_met") return `requirement:${failure.requirement?.type ?? "unknown"}`;
  return failure.type ?? "unknown";
}

function formatFailure(failure) {
  if (failure.type === "requirement_not_met") {
    const requirement = failure.requirement ?? {};
    const location = [requirement.sheet, requirement.range ?? requirement.cell].filter(Boolean).join("!");
    const mismatch = requirement.mismatches?.[0];
    const comparison = mismatch
      ? `${mismatch.address}: expected ${JSON.stringify(mismatch.expected)}, actual ${JSON.stringify(mismatch.actual)}`
      : `expected ${JSON.stringify(requirement.expected ?? requirement.minimum ?? "pass")}, actual ${JSON.stringify(requirement.actual ?? requirement.matched ?? "failed")}`;
    return `${requirement.type}${location ? ` (${location})` : ""}: ${comparison}`;
  }
  if (String(failure.type).startsWith("chart_")) {
    return `${failure.type} (${failure.chart ?? "chart"}, series ${failure.series ?? 0}): ${JSON.stringify(failure)}`;
  }
  const location = [failure.sheet, failure.range ?? failure.address ?? failure.cell].filter(Boolean).join("!");
  return `${failure.type}${location ? ` (${location})` : ""}: ${JSON.stringify(failure)}`;
}

function summarizeFailures(failures, maxCategories = 12) {
  const groups = new Map();
  for (const failure of failures ?? []) {
    const category = failureCategory(failure);
    const group = groups.get(category) ?? { count: 0, sample: failure };
    group.count += 1;
    groups.set(category, group);
  }
  const summaries = [...groups.entries()].slice(0, maxCategories).map(([category, group]) => (
    `${category} ×${group.count}: ${formatFailure(group.sample)}`
  ));
  if (groups.size > maxCategories) summaries.push(`${groups.size - maxCategories} additional failure categories; inspect the build report for full details`);
  return summaries.join("; ");
}

function summarizeAuditFailures(audit) {
  return summarizeFailures(audit.hardFailures);
}

async function auditDelimited(filePath) {
  const report = await inspectDelimited(filePath, { "max-rows": 5, "max-cols": 20 });
  const failures = [];
  const warnings = [];
  if (report.inconsistentRowWidths) warnings.push({ type: "inconsistent_row_widths" });
  if (report.rowCount === 0) warnings.push({ type: "empty_file" });
  return {
    status: failures.length > 0 ? "error" : warnings.length > 0 ? "partial" : "ok",
    path: report.path,
    format: report.format,
    rowCount: report.rowCount,
    maxColumnCount: report.maxColumnCount,
    hardFailures: failures,
    warnings,
  };
}

function findSoffice() {
  const configured = process.env.SPREADSHEET_SKILL_SOFFICE;
  if (configured) return configured;
  if (process.platform === "darwin") return "/Applications/LibreOffice.app/Contents/MacOS/soffice";
  return "soffice";
}

function findRenderer() {
  return process.env.SPREADSHEET_SKILL_PDF_RENDERER || "";
}

async function runLibreOffice(args, profileDir) {
  const soffice = findSoffice();
  if (!soffice || !(await pathExists(soffice)) && path.isAbsolute(soffice)) {
    throw unsupported("libreoffice-unavailable", "LibreOffice was not found. Install LibreOffice or expose soffice on PATH.");
  }
  const fontDirectories = [
    path.join(skillRoot, "assets", "fonts"),
    "/System/Library/Fonts",
    "/System/Library/Fonts/Supplemental",
    "/Library/Fonts",
    path.join(os.homedir(), "Library", "Fonts"),
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    path.join(os.homedir(), ".fonts"),
    process.env.WINDIR ? path.join(process.env.WINDIR, "Fonts") : "C:/Windows/Fonts",
    "/c/Windows/Fonts",
  ];
  const availableFontDirectories = [];
  for (const directory of fontDirectories) if (await pathExists(directory)) availableFontDirectories.push(directory);
  const fontCache = path.join(profileDir, "font-cache");
  await fs.mkdir(fontCache, { recursive: true });
  const fontconfigPath = path.join(profileDir, "fonts.conf");
  const xmlEscape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  await fs.writeFile(fontconfigPath, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>${availableFontDirectories.map((directory) => `<dir>${xmlEscape(directory)}</dir>`).join("")}<cachedir>${xmlEscape(fontCache)}</cachedir></fontconfig>`, "utf8");
  const profileArg = `-env:UserInstallation=${pathToFileURL(profileDir).href}`;
  const result = await execFileAsync(soffice, [
    profileArg,
    "--headless",
    "--nologo",
    "--nodefault",
    "--nofirststartwizard",
    "--norestore",
    ...args,
  ], { timeout: 120000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, FONTCONFIG_FILE: fontconfigPath } });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function prepareWorkbookForRecalculation(inputPath, outputPath) {
  const source = await fs.readFile(inputPath);
  const zip = await JSZip.loadAsync(source);
  const workbookPart = zip.file("xl/workbook.xml");
  if (!workbookPart) throw new Error("The XLSX package is missing xl/workbook.xml");
  let workbookXml = await workbookPart.async("string");
  if (/<calcPr\b[^>]*\/>/.test(workbookXml)) {
    workbookXml = workbookXml.replace(/<calcPr\b([^>]*)\/>/, (_match, attributes) => {
      const preserved = attributes.replace(/\s(?:calcMode|fullCalcOnLoad|forceFullCalc)="[^"]*"/g, "");
      return `<calcPr${preserved} calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>`;
    });
  } else {
    workbookXml = workbookXml.replace("</workbook>", '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>');
  }
  zip.file("xl/workbook.xml", workbookXml);

  const worksheetParts = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name));
  for (const worksheetPart of worksheetParts) {
    let worksheetXml = await zip.file(worksheetPart).async("string");
    worksheetXml = worksheetXml.replace(
      /<c\b([^>]*)>([\s\S]*?<f[^>]*>)([\s\S]*?<\/f>)(?:<v>[^<]*<\/v>)?([\s\S]*?)<\/c>/g,
      (_match, cellAttributes, formulaOpen, formulaBody, remainder) => {
        const normalizedFormula = formulaBody.replace(/^=/, "");
        return `<c${cellAttributes}>${formulaOpen}${normalizedFormula}${remainder}</c>`;
      },
    );
    zip.file(worksheetPart, worksheetXml);
  }

  await ensureParent(outputPath);
  const prepared = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await fs.writeFile(outputPath, prepared);
}

async function recalculateWorkbook(inputPath, outputPath) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-recalc-"));
  try {
    const sourceDir = path.join(tempRoot, "source");
    const convertedDir = path.join(tempRoot, "converted");
    const profileDir = path.join(tempRoot, "profile");
    await Promise.all([
      fs.mkdir(sourceDir, { recursive: true }),
      fs.mkdir(convertedDir, { recursive: true }),
      fs.mkdir(profileDir, { recursive: true }),
    ]);
    const sourcePath = path.join(sourceDir, "workbook.xlsx");
    await prepareWorkbookForRecalculation(inputPath, sourcePath);
    const conversion = await runLibreOffice([
      "--convert-to",
      "xlsx:Calc MS Excel 2007 XML",
      "--outdir",
      convertedDir,
      sourcePath,
    ], profileDir);
    const convertedPath = path.join(convertedDir, "workbook.xlsx");
    if (!(await pathExists(convertedPath))) {
      throw new Error(`LibreOffice did not produce a recalculated XLSX. ${conversion.stderr || conversion.stdout}`.trim());
    }
    const compatibilityNormalization = await normalizeLibreOfficeRoundTripPackage(convertedPath);
    await ensureParent(outputPath);
    await fs.copyFile(convertedPath, outputPath);
    return { output: path.resolve(outputPath), engine: "LibreOffice", compatibilityNormalization };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function convertLegacyXls(inputPath, outputPath) {
  if (workbookExtension(inputPath) !== ".xls" || workbookExtension(outputPath) !== ".xlsx") {
    throw new Error("Legacy conversion requires .xls input and .xlsx output");
  }
  if (pathsReferToSameLocation(inputPath, outputPath)) throw new Error("Refusing to overwrite the legacy source workbook");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-xls-"));
  try {
    const sourceDir = path.join(tempRoot, "source");
    const convertedDir = path.join(tempRoot, "converted");
    const profileDir = path.join(tempRoot, "profile");
    await Promise.all([fs.mkdir(sourceDir, { recursive: true }), fs.mkdir(convertedDir, { recursive: true }), fs.mkdir(profileDir, { recursive: true })]);
    const sourcePath = path.join(sourceDir, "workbook.xls");
    await fs.copyFile(inputPath, sourcePath);
    const conversion = await runLibreOffice(["--convert-to", "xlsx:Calc MS Excel 2007 XML", "--outdir", convertedDir, sourcePath], profileDir);
    const convertedPath = path.join(convertedDir, "workbook.xlsx");
    if (!(await pathExists(convertedPath))) throw new Error(`LibreOffice did not convert the legacy XLS file. ${conversion.stderr || conversion.stdout}`.trim());
    const compatibilityNormalization = await normalizeLibreOfficeRoundTripPackage(convertedPath);
    const workbook = await loadXlsx(convertedPath);
    if (workbook.worksheets.length === 0) throw new Error("Converted XLSX has no worksheets");
    if (workbook.worksheets.every((worksheet) => worksheet.actualRowCount === 0)) throw new Error("Converted XLSX contains no populated worksheets");
    await ensureParent(outputPath);
    await fs.copyFile(convertedPath, outputPath);
    const audit = await auditXlsx(outputPath);
    if (audit.status === "error") throw new Error("Converted XLSX failed structural or formula audit");
    return { status: audit.status, input: path.resolve(inputPath), output: path.resolve(outputPath), engine: "LibreOffice", compatibilityNormalization, audit };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function delimitedCellValue(cell) {
  const formula = formulaDescriptor(cell);
  const value = formula ? formula.result : cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.error === "string") return value.error;
    return JSON.stringify(serializableValue(value));
  }
  return String(value);
}

function escapeDelimited(value, delimiter) {
  const text = String(value ?? "");
  if (text.includes(delimiter) || text.includes('"') || /[\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

async function exportDelimited(workbook, outputPath, sheetName, encoding = "utf8-bom") {
  const worksheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!worksheet) throw new Error(sheetName ? `Worksheet '${sheetName}' was not found` : "Workbook has no worksheets");
  const delimiter = workbookExtension(outputPath) === ".tsv" ? "\t" : ",";
  const lines = [];
  const lastRow = Math.max(worksheet.rowCount, worksheet.actualRowCount, 0);
  const lastCol = Math.max(worksheet.columnCount, worksheet.actualColumnCount, 0);
  for (let row = 1; row <= lastRow; row += 1) {
    const values = [];
    for (let col = 1; col <= lastCol; col += 1) {
      values.push(escapeDelimited(delimitedCellValue(worksheet.getCell(row, col)), delimiter));
    }
    lines.push(values.join(delimiter));
  }
  await ensureParent(outputPath);
  await fs.writeFile(outputPath, encodeDelimitedText(`${lines.join("\n")}\n`, encoding));
}

function createToolkit(inputPath) {
  return {
    ExcelJS: guardedExcelJsApi(),
    inputPath: inputPath ? path.resolve(inputPath) : null,
    createWorkbook,
    loadWorkbook,
    loadXlsx,
    loadDelimited,
    helpers: {
      addConditionalFormatting,
      addImage,
      addListValidation,
      addNativeChart(workbook, spec) {
        const current = NATIVE_CHART_SPECS.get(workbook) ?? [];
        current.push(structuredClone(spec));
        NATIVE_CHART_SPECS.set(workbook, current);
      },
      addTableFromRange,
      applyStyle,
      applyChineseTypography,
      autoFitColumns,
      autoFitRows,
      fontProfile,
      forEachCellInRange,
      setNumberFormat,
      styleHeader,
      parseRangeReference,
      columnLetters,
      columnNumber,
      integrity: {
        register(workbook, plan) {
          if (!workbook || typeof workbook.xlsx?.writeFile !== "function") throw new Error("integrity.register requires the builder workbook");
          const validated = validateNumericIntegrityPlan(structuredClone(plan), "builder integrity plan");
          if (validated.draft === true) throw new Error("builder integrity plan cannot remain draft");
          REGISTERED_INTEGRITY_PLANS.set(workbook, validated);
          return validated;
        },
      },
    },
  };
}

function validateNativeChartSpec(workbook, spec, location) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error(`${location} must be an object`);
  if (!spec.sheet || !workbook.getWorksheet(spec.sheet)) throw new Error(`${location}.sheet references missing worksheet '${spec.sheet ?? ""}'`);
  if (!["line", "column", "bar"].includes(spec.type)) throw new Error(`${location}.type must be line, column, or bar`);
  if (typeof spec.categories !== "string" || spec.categories.trim().length === 0) throw new Error(`${location}.categories must be a non-empty range`);
  if (spec.minPoints !== undefined && (!Number.isInteger(spec.minPoints) || spec.minPoints < 1)) throw new Error(`${location}.minPoints must be a positive integer`);
  if (!Array.isArray(spec.series) || spec.series.length === 0) throw new Error(`${location}.series must contain at least one series`);
  spec.series.forEach((series, index) => {
    if (!series || typeof series.name !== "string" || series.name.trim().length === 0 || typeof series.values !== "string" || series.values.trim().length === 0) {
      throw new Error(`${location}.series[${index}] requires non-empty name and values`);
    }
  });
}

function validateWorkbookForSerialization(workbook, nativeCharts) {
  if (workbook.worksheets.length === 0) throw new Error("Workbook must contain at least one worksheet");
  for (const worksheet of workbook.worksheets) {
    for (const [index, entry] of (worksheet.conditionalFormattings ?? []).entries()) {
      validateConditionalFormattingEntry(entry, `worksheet '${worksheet.name}' conditionalFormattings[${index}]`);
    }
  }
  if (!Array.isArray(nativeCharts)) throw new Error("Builder nativeCharts must be an array");
  nativeCharts.forEach((spec, index) => validateNativeChartSpec(workbook, spec, `nativeCharts[${index}]`));
}

async function buildFromBuilder(builderPath, inputPath) {
  const builderUrl = `${pathToFileURL(path.resolve(builderPath)).href}?pilotdeck=${Date.now()}`;
  const module = await import(builderUrl);
  if (typeof module.default !== "function") throw new Error("The builder must export a default async function");
  const product = await module.default(createToolkit(inputPath));
  const workbook = product?.workbook ?? product;
  if (!workbook || typeof workbook.xlsx?.writeFile !== "function") {
    throw new Error("The builder must return an ExcelJS Workbook or { workbook, sheetName? }");
  }
  return {
    workbook,
    sheetName: product?.workbook ? product.sheetName : undefined,
    nativeCharts: product?.nativeCharts ?? NATIVE_CHART_SPECS.get(workbook) ?? [],
    insertedImages: INSERTED_IMAGE_SPECS.get(workbook) ?? [],
    requirements: product?.requirements ?? null,
    integrityPlan: product?.integrityPlan ?? REGISTERED_INTEGRITY_PLANS.get(workbook) ?? null,
  };
}

async function commandScaffold(options) {
  const outputPath = assertInternalArtifactPath(requireOption(options, "out"), "Spreadsheet builder");
  const starter = path.join(skillRoot, "assets", "starter-workbook.mjs");
  if (options["requirements-out"]) {
    throw blocked("prepare-required", "Requirements must be created and policy-frozen by prepare before scaffold", { next: "Run prepare, then scaffold only the builder path returned by prepare." });
  }
  if (await pathExists(outputPath)) throw new Error(`Refusing to overwrite existing builder: ${outputPath}`);
  await ensureParent(outputPath);
  await fs.copyFile(starter, outputPath);
  await emitReport({ status: "ok", output: path.resolve(outputPath) }, options.report && String(options.report));
}

function spreadsheetTaskPaths() {
  const workDir = pilotDeckWorkDir();
  if (!workDir) {
    throw blocked(
      "work-dir-unavailable",
      "PILOTDECK_WORK_DIR is required for deterministic spreadsheet task setup",
      { next: "Use the current turn work directory; do not guess another task's directory." },
    );
  }
  const root = path.join(workDir, "spreadsheets");
  return {
    root,
    tmp: path.join(root, "tmp"),
    qa: path.join(root, "qa"),
    builder: path.join(root, "tmp", "workbook.mjs"),
    candidate: path.join(root, "tmp", "candidate.xlsx"),
    requirements: path.join(root, "qa", "requirements.json"),
    sourceEvidence: path.join(root, "qa", "source-evidence.json"),
    integrityPlan: path.join(root, "qa", "integrity-plan.json"),
    integrityReport: path.join(root, "qa", "numeric-integrity.json"),
    attestation: path.join(root, "qa", "attestation.json"),
    projectSnapshot: path.join(root, "qa", "project-snapshot.json"),
    visualReview: path.join(root, "qa", "visual-review.json"),
    render: path.join(root, "qa", "render"),
    deliveryReport: path.join(root, "qa", "delivery.json"),
  };
}

function projectSnapshotIgnoredPath(absolutePath, { root, finalOutput, workDir }) {
  if (pathsReferToSameLocation(absolutePath, finalOutput)) return true;
  if (workDir && isInsidePath(resolveThroughExistingAncestor(absolutePath), resolveThroughExistingAncestor(workDir))) return true;
  const relative = path.relative(root, absolutePath);
  const segments = relative.split(path.sep).filter(Boolean);
  return segments.some((segment) => [".git", ".pilotdeck", "node_modules"].includes(segment));
}

async function captureProjectSnapshot(rootPath, { finalOutput, workDir = pilotDeckWorkDir() }) {
  const root = path.resolve(rootPath);
  if (!(await pathExists(root))) throw new Error(`Spreadsheet project directory not found: ${root}`);
  const files = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (projectSnapshotIgnoredPath(absolute, { root, finalOutput, workDir })) continue;
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const stat = await fs.stat(absolute);
        files.push({ path: relative, type: "file", size: stat.size, sha256: await fileSha256(absolute) });
      } else if (entry.isSymbolicLink()) {
        const target = await fs.readlink(absolute);
        files.push({ path: relative, type: "symlink", target, sha256: crypto.createHash("sha256").update(target).digest("hex") });
      }
    }
  }
  await visit(root);
  return {
    protocol: PROJECT_SNAPSHOT_PROTOCOL,
    root,
    finalOutput: path.resolve(finalOutput),
    files,
  };
}

async function captureProjectGuardSnapshot(rootPath, { finalOutput, workDir = pilotDeckWorkDir() }) {
  const root = path.resolve(rootPath);
  if (!(await pathExists(root))) throw new Error(`Spreadsheet project directory not found: ${root}`);
  const files = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (projectSnapshotIgnoredPath(absolute, { root, finalOutput, workDir })) continue;
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push({ path: relative, type: "file" });
      else if (entry.isSymbolicLink()) files.push({ path: relative, type: "symlink" });
    }
  }
  await visit(root);
  return {
    protocol: PROJECT_GUARD_PROTOCOL,
    root,
    finalOutput: path.resolve(finalOutput),
    files,
  };
}

function compareProjectSnapshots(before, after) {
  const beforeFiles = new Map(before.files.map((item) => [item.path, item]));
  const afterFiles = new Map(after.files.map((item) => [item.path, item]));
  const created = [];
  const modified = [];
  const deleted = [];
  for (const [filePath, item] of afterFiles.entries()) {
    const previous = beforeFiles.get(filePath);
    if (!previous) created.push(item);
    else if (previous.sha256 !== item.sha256 || previous.type !== item.type) modified.push({ before: previous, after: item });
  }
  for (const [filePath, item] of beforeFiles.entries()) if (!afterFiles.has(filePath)) deleted.push(item);
  return { clean: created.length === 0 && modified.length === 0 && deleted.length === 0, created, modified, deleted };
}

async function assertProjectWorkspaceClean(requirements) {
  const binding = requirements?.task?.projectSnapshot;
  if (!binding) return { status: "not_requested" };
  const snapshotPath = assertInternalArtifactPath(binding.path, "Spreadsheet project snapshot");
  const actualSnapshotSha256 = await fileSha256(snapshotPath);
  if (actualSnapshotSha256 !== binding.sha256.toLowerCase()) {
    throw blocked("stale-project-snapshot", "The spreadsheet project snapshot changed after prepare", {
      path: snapshotPath,
      expectedSha256: binding.sha256.toLowerCase(),
      actualSha256: actualSnapshotSha256,
    });
  }
  const before = await readJsonFile(snapshotPath, "Spreadsheet project snapshot");
  if (![PROJECT_SNAPSHOT_PROTOCOL, PROJECT_GUARD_PROTOCOL].includes(before.protocol) || !Array.isArray(before.files) || !path.isAbsolute(before.root)) {
    throw new Error(`Invalid spreadsheet project snapshot: ${snapshotPath}`);
  }
  if (before.protocol === PROJECT_GUARD_PROTOCOL) {
    const after = await captureProjectGuardSnapshot(before.root, { finalOutput: requirements.task.finalOutput });
    const guard = compareProjectGuard(before, after);
    if (!guard.clean) {
      throw blocked("spreadsheet-project-artifacts", "Spreadsheet build artifacts leaked into the project directory", {
        root: before.root,
        suspicious: guard.suspicious.slice(0, 20).map((item) => item.path),
        count: guard.suspicious.length,
        next: "Move only the listed spreadsheet build artifacts under PILOTDECK_WORK_DIR; unrelated project changes do not need to be reverted.",
      });
    }
    return { status: "passed", root: before.root, checkedCreatedFiles: guard.created.length, suspicious: 0 };
  }
  const after = await captureProjectSnapshot(before.root, { finalOutput: requirements.task.finalOutput });
  const diff = compareProjectSnapshots(before, after);
  if (!diff.clean) {
    throw blocked("spreadsheet-project-dirty", "Unexpected files changed in the project directory during spreadsheet generation", {
      root: before.root,
      created: diff.created.slice(0, 20).map((item) => item.path),
      modified: diff.modified.slice(0, 20).map((item) => item.after.path),
      deleted: diff.deleted.slice(0, 20).map((item) => item.path),
      counts: { created: diff.created.length, modified: diff.modified.length, deleted: diff.deleted.length },
      next: "Move builders, comparison reports, normalized sources, and debug files under PILOTDECK_WORK_DIR; restore any modified project inputs; then prepare and build again.",
    });
  }
  return { status: "passed", root: before.root, files: before.files.length };
}

function spreadsheetLineagePath() {
  const workDir = pilotDeckWorkDir();
  return workDir ? path.join(path.dirname(workDir), "spreadsheet-lineage.json") : null;
}

function emptySpreadsheetLineage() {
  return { schemaVersion: 1, sessionId: process.env.PILOTDECK_SESSION_ID ?? null, workbooks: [] };
}

async function loadSpreadsheetLineage() {
  const statePath = spreadsheetLineagePath();
  if (!statePath || !(await pathExists(statePath))) return { statePath, state: emptySpreadsheetLineage() };
  const state = await readJsonFile(statePath, "Spreadsheet lineage");
  if (state.schemaVersion !== 1 || !Array.isArray(state.workbooks)) throw new Error(`Invalid spreadsheet lineage state: ${statePath}`);
  return { statePath, state };
}

function lineagePaths(chain) {
  const paths = [chain.origin?.path, chain.current?.path];
  for (const revision of chain.revisions ?? []) paths.push(revision.source?.path, revision.output?.path);
  return paths.filter(Boolean);
}

function findSpreadsheetLineage(state, requestedPath) {
  return state.workbooks.find((chain) => lineagePaths(chain).some((item) => pathsReferToSameLocation(item, requestedPath))) ?? null;
}

async function resolveLatestSpreadsheetInput(requestedPath, { useExactInput = false } = {}) {
  const requested = path.resolve(requestedPath);
  if (!(await pathExists(requested))) throw new Error(`Spreadsheet input not found: ${requested}`);
  if (workbookExtension(requested) !== ".xlsx") return { status: "ok", requested, resolved: requested, tracked: false, isLatest: true };
  if (useExactInput) return { status: "ok", requested, resolved: requested, tracked: false, isLatest: true, code: "exact-spreadsheet-input" };
  const { state } = await loadSpreadsheetLineage();
  const chain = findSpreadsheetLineage(state, requested);
  if (!chain) return { status: "ok", requested, resolved: requested, tracked: false, isLatest: true, code: "untracked-spreadsheet-input" };
  const latest = path.resolve(chain.current?.path ?? "");
  if (!latest || !(await pathExists(latest))) throw blocked("spreadsheet-lineage-missing", "The latest tracked spreadsheet no longer exists", { latest, chainId: chain.id });
  const actualSha256 = await fileSha256(latest);
  if (actualSha256 !== chain.current.sha256) {
    throw blocked("spreadsheet-lineage-diverged", "The latest tracked spreadsheet changed outside the version chain", {
      latest,
      expectedSha256: chain.current.sha256,
      actualSha256,
      next: "Inspect the changed workbook and use --use-exact-input only if it is intentionally the new editing base.",
    });
  }
  return {
    status: "ok",
    code: pathsReferToSameLocation(requested, latest) ? "latest-spreadsheet-input" : "latest-spreadsheet-resolved",
    requested,
    resolved: latest,
    tracked: true,
    isLatest: pathsReferToSameLocation(requested, latest),
    chainId: chain.id,
    revision: chain.revisions?.length ?? 0,
    sha256: actualSha256,
  };
}

async function recordSpreadsheetDelivery(outputPath, sourceItem, candidateSha256) {
  const { statePath, state } = await loadSpreadsheetLineage();
  if (!statePath) return null;
  const output = { path: path.resolve(outputPath), sha256: candidateSha256 };
  let chain = findSpreadsheetLineage(state, sourceItem?.path ?? output.path);
  if (!chain) {
    const origin = sourceItem ?? output;
    chain = {
      id: crypto.createHash("sha256").update(`${process.env.PILOTDECK_SESSION_ID ?? ""}\0${origin.path}`).digest("hex").slice(0, 20),
      origin,
      current: output,
      revisions: [],
    };
    state.workbooks.push(chain);
  }
  const revision = {
    revision: chain.revisions.length + 1,
    source: sourceItem ?? null,
    output,
    turnId: process.env.PILOTDECK_TURN_ID ?? null,
  };
  chain.revisions.push(revision);
  chain.current = output;
  await ensureParent(statePath);
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return { state: statePath, chainId: chain.id, revision: revision.revision, current: output };
}

async function commandResolveLatest(options) {
  await emitReport(await resolveLatestSpreadsheetInput(requireOption(options, "input"), { useExactInput: Boolean(options["use-exact-input"]) }));
}

async function commandPrepare(options) {
  const paths = spreadsheetTaskPaths();
  const requirementsPath = options["requirements-out"]
    ? assertInternalArtifactPath(requireOption(options, "requirements-out"), "Spreadsheet requirements")
    : paths.requirements;
  const finalOutput = assertDeliveryOutputPath(requireOption(options, "final-out"));
  const requirementsExist = await pathExists(requirementsPath);
  const existingRequirements = requirementsExist
    ? await readJsonFile(requirementsPath, "Existing spreadsheet requirements")
    : null;
  if (existingRequirements) validateRequirements(existingRequirements, requirementsPath);
  if (requirementsExist && !options.overwrite) {
    throw blocked("requirements-frozen", "The prepared spreadsheet requirements already exist", {
      requirements: requirementsPath,
      next: "Reuse them, or pass --overwrite only when the current user changed the task acceptance.",
    });
  }
  const clearSources = Boolean(options["clear-sources"]);
  const explicitSourcePaths = [...new Set(optionValues(options, "source").map((item) => path.resolve(item)))];
  if (clearSources && explicitSourcePaths.length > 0) throw new Error("--clear-sources cannot be combined with --source");
  const preserveExistingSources = Boolean(
    existingRequirements?.numericIntegrity
    && explicitSourcePaths.length === 0
    && !clearSources,
  );
  const sourcePaths = preserveExistingSources
    ? (existingRequirements.sourceFiles ?? []).map((item) => path.resolve(item.origin?.path ?? item.path))
    : explicitSourcePaths;
  for (const sourcePath of sourcePaths) {
    if (!(await pathExists(sourcePath))) throw new Error(`Numeric-integrity source not found: ${sourcePath}`);
    assertEvidenceSource(sourcePath);
  }
  if (workbookExtension(finalOutput) !== ".xlsx") throw new Error("--final-out must end in .xlsx");
  const workbookType = String(options["workbook-type"] ?? existingRequirements?.task?.workbookType ?? "data");
  if (!WORKBOOK_TYPES.has(workbookType)) throw new Error(`--workbook-type must be one of ${[...WORKBOOK_TYPES].join(", ")}`);
  const requestedInputPath = options.input
    ? path.resolve(requireOption(options, "input"))
    : existingRequirements?.task?.input?.path ?? null;
  const inputResolution = requestedInputPath
    ? await resolveLatestSpreadsheetInput(requestedInputPath, { useExactInput: Boolean(options["use-exact-input"]) })
    : null;
  const inputPath = inputResolution?.resolved ?? null;
  if (inputPath) {
    assertSupportedInput(inputPath);
    if (workbookExtension(inputPath) !== ".xlsx") throw unsupported("prepare-xlsx-only", "Modifying tasks prepared by this protocol currently require .xlsx input");
    if (!(await pathExists(inputPath))) throw new Error(`Input workbook not found: ${inputPath}`);
    if (pathsReferToSameLocation(inputPath, finalOutput)) {
      throw blocked("source-replacement-unsupported", "Spreadsheet source replacement is not enabled; choose a new final output path");
    }
  }
  const styleMode = String(options["style-mode"] ?? existingRequirements?.task?.styleMode ?? (inputPath ? "preserve-source" : "neutral-built-in"));
  if (!STYLE_MODES.has(styleMode)) throw new Error(`--style-mode must be one of ${[...STYLE_MODES].join(", ")}`);
  if (styleMode === "preserve-source" && !inputPath) throw new Error("--style-mode preserve-source requires --input");
  const styleSourcePath = options["style-source"]
    ? path.resolve(requireOption(options, "style-source"))
    : existingRequirements?.task?.styleSource?.path ?? null;
  if (styleMode === "user-template" && !styleSourcePath) throw new Error("--style-mode user-template requires --style-source");
  if (styleSourcePath && !(await pathExists(styleSourcePath))) throw new Error(`Style source not found: ${styleSourcePath}`);
  if (styleSourcePath && workbookExtension(styleSourcePath) !== ".xlsx") throw new Error("--style-source must be an .xlsx workbook");

  const hasImageSources = sourcePaths.some((sourcePath) => EVIDENCE_IMAGE_EXTENSIONS.has(workbookExtension(sourcePath)));
  const dataOperation = String(options["data-operation"] ?? existingRequirements?.task?.dataOperation ?? defaultDataOperation({
    sourceCount: sourcePaths.length,
    hasImageSources,
    hasInput: Boolean(inputPath),
  }));
  const taskProfile = deriveTaskProfile({
    requestedProfile: options["validation-profile"]
      ? String(options["validation-profile"])
      : existingRequirements?.task?.validationProfile ?? null,
    dataOperation,
    sourceCount: sourcePaths.length,
    hasImageSources,
    hasInput: Boolean(inputPath),
  });

  const visualMode = String(options["visual-review-mode"] ?? existingRequirements?.task?.visualReview?.mode ?? "adaptive");
  if (!VISUAL_REVIEW_MODES.has(visualMode)) throw new Error(`--visual-review-mode must be one of ${[...VISUAL_REVIEW_MODES].join(", ")}`);
  const visualSheets = optionValues(options, "visual-sheet").length > 0
    ? optionValues(options, "visual-sheet")
    : existingRequirements?.task?.visualReview?.sheets ?? [];
  if (visualMode === "selected-sheets" && visualSheets.length === 0) throw new Error("selected-sheets visual review requires at least one --visual-sheet");
  if (visualMode === "structural-only" && (workbookType !== "data" || !options["allow-structural-only"])) {
    throw blocked(
      "visual-review-required",
      "Structural-only QA is restricted to explicitly authorized data workbooks",
      { next: "Use all-pages/selected-sheets, or pass --allow-structural-only only when the user explicitly accepts no visual QA." },
    );
  }
  await Promise.all([fs.mkdir(paths.tmp, { recursive: true }), fs.mkdir(paths.qa, { recursive: true })]);
  let projectSnapshotBinding;
  if (existingRequirements?.task?.projectSnapshot) {
    const existingBinding = existingRequirements.task.projectSnapshot;
    const snapshotPath = assertInternalArtifactPath(existingBinding.path, "Spreadsheet project snapshot");
    if (!(await pathExists(snapshotPath)) || await fileSha256(snapshotPath) !== existingBinding.sha256.toLowerCase()) {
      throw blocked("stale-project-snapshot", "The original project snapshot cannot be reused safely", {
        path: snapshotPath,
        next: "Start a new spreadsheet task instead of replacing the baseline after project files may have changed.",
      });
    }
    const originalSnapshot = await readJsonFile(snapshotPath, "Spreadsheet project snapshot");
    if (!pathsReferToSameLocation(originalSnapshot.root, path.dirname(finalOutput))) {
      throw blocked("prepare-output-root-changed", "An overwrite cannot move the final workbook to another project directory", {
        originalRoot: originalSnapshot.root,
        requestedRoot: path.dirname(finalOutput),
        next: "Start a new spreadsheet task for a different output directory.",
      });
    }
    projectSnapshotBinding = existingBinding;
  } else {
    const projectSnapshot = await captureProjectGuardSnapshot(path.dirname(finalOutput), { finalOutput });
    await writeJson(paths.projectSnapshot, projectSnapshot);
    projectSnapshotBinding = {
      protocol: projectSnapshot.protocol,
      path: paths.projectSnapshot,
      sha256: await fileSha256(paths.projectSnapshot),
    };
  }

  const task = {
    protocol: TASK_PROTOCOL,
    workbookType,
    styleMode,
    validationProfile: taskProfile.profile,
    minimumValidationProfile: taskProfile.minimumProfile,
    dataOperation: taskProfile.dataOperation,
    profileReasons: taskProfile.reasons,
    ...(styleSourcePath ? { styleSource: { path: styleSourcePath, sha256: await fileSha256(styleSourcePath) } } : {}),
    ...(inputPath ? { input: { path: inputPath, sha256: await fileSha256(inputPath) } } : {}),
    finalOutput,
    visualReview: {
      mode: visualMode,
      ...(visualMode === "selected-sheets" ? { sheets: [...new Set(visualSheets)] } : {}),
    },
    allowDecorativeTitle: options["allow-decorative-title"] !== undefined
      ? Boolean(options["allow-decorative-title"])
      : Boolean(existingRequirements?.task?.allowDecorativeTitle),
    allowedAccentColors: optionValues(options, "allow-accent-color").length > 0
      ? optionValues(options, "allow-accent-color").map((color) => color.toUpperCase())
      : existingRequirements?.task?.allowedAccentColors ?? [],
    projectSnapshot: projectSnapshotBinding,
  };
  let sourceEvidence = null;
  let sourceFiles = null;
  let numericIntegrity = null;
  if (preserveExistingSources) {
    const integrityChecks = await evaluateSourceFiles(existingRequirements);
    const failedChecks = integrityChecks.filter((check) => !check.passed);
    if (failedChecks.length > 0) {
      throw blocked("prepare-source-changed", "Existing numeric-integrity sources changed after the original prepare", {
        failures: failedChecks,
        next: "Inspect the changed source and start a new spreadsheet task; do not silently replace the frozen evidence.",
      });
    }
    const evidencePath = assertInternalArtifactPath(existingRequirements.numericIntegrity.evidence.path, "Spreadsheet source evidence");
    const planPath = assertInternalArtifactPath(existingRequirements.numericIntegrity.plan.path, "Spreadsheet numeric-integrity plan");
    sourceEvidence = validateSourceEvidence(await readJsonFile(evidencePath, "Spreadsheet source evidence"));
    if (!(await pathExists(planPath))) throw new Error(`Spreadsheet numeric-integrity plan not found: ${planPath}`);
    sourceFiles = existingRequirements.sourceFiles;
    numericIntegrity = {
      protocol: NUMERIC_INTEGRITY_PROTOCOL,
      mode: "strict",
      state: "prepared",
      evidence: { path: evidencePath, sha256: await fileSha256(evidencePath) },
      plan: { path: planPath },
      blockOnUnverified: true,
    };
  } else if (sourcePaths.length > 0) {
    sourceEvidence = await captureSourceEvidence(sourcePaths, { normalizedRoot: path.join(paths.tmp, "normalized-sources") });
    await writeJson(paths.sourceEvidence, sourceEvidence);
    await writeJson(paths.integrityPlan, numericIntegrityPlanTemplate());
    sourceFiles = sourceEvidence.sources.map((source) => ({
      path: source.path,
      sha256: source.sha256,
      origin: { path: source.origin.path, sha256: source.origin.sha256 },
      ...(source.normalization ? { normalization: source.normalization } : {}),
    }));
    numericIntegrity = {
      protocol: NUMERIC_INTEGRITY_PROTOCOL,
      mode: "strict",
      state: "prepared",
      evidence: { path: paths.sourceEvidence, sha256: await fileSha256(paths.sourceEvidence) },
      plan: { path: paths.integrityPlan },
      blockOnUnverified: true,
    };
  }
  const requirements = validateRequirements({
    task,
    ...(sourceEvidence ? {
      sourceBacked: true,
      sourceFiles,
      sourceBackedSheets: [],
      numericIntegrity,
    } : {}),
    requiredSheets: existingRequirements?.requiredSheets ?? [],
    ...(existingRequirements?.exactSheetCount !== undefined ? { exactSheetCount: existingRequirements.exactSheetCount } : {}),
    ...(existingRequirements?.minFormulaCount !== undefined ? { minFormulaCount: existingRequirements.minFormulaCount } : {}),
    requiredFormulaRanges: existingRequirements?.requiredFormulaRanges ?? [],
    requiredNonEmptyRanges: existingRequirements?.requiredNonEmptyRanges ?? [],
    expectedCells: existingRequirements?.expectedCells ?? [],
    expectedRanges: existingRequirements?.expectedRanges ?? [],
    requiredCellTypes: existingRequirements?.requiredCellTypes ?? [],
    requiredNativeCharts: existingRequirements?.requiredNativeCharts ?? [],
    requiredImages: existingRequirements?.requiredImages ?? [],
    requiredTables: existingRequirements?.requiredTables ?? [],
    requiredConditionalFormatting: existingRequirements?.requiredConditionalFormatting ?? [],
    requiredDataValidations: existingRequirements?.requiredDataValidations ?? [],
    ...(existingRequirements?.maxTotalPages !== undefined ? { maxTotalPages: existingRequirements.maxTotalPages } : {}),
    maxPagesPerSheet: existingRequirements?.maxPagesPerSheet ?? [],
    warningDispositions: existingRequirements?.warningDispositions ?? [],
  }, "prepared requirements");
  await writeJson(requirementsPath, requirements);
  const report = {
    status: "ok",
    protocol: TASK_PROTOCOL,
    paths: { ...paths, requirements: requirementsPath },
    task,
    ...(inputResolution ? { inputResolution } : {}),
    sources: sourceEvidence ? {
      status: preserveExistingSources ? "preserved" : "captured",
      count: sourceEvidence.sources.length,
    } : { status: clearSources ? "cleared" : "not_requested", count: 0 },
    next: sourceEvidence
      ? `Declare the source-to-output lineage once in the builder with helpers.integrity.register(workbook, plan), then build; the runtime binds and audits it automatically. Use integrity-scaffold only for legacy debugging.`
      : "Add only task-relevant declarative checks, then build once; build will write a reusable audit attestation.",
  };
  if (!options.quiet) await emitReport(report);
  return report;
}

function unresolvedIntegrityPlaceholders(value, location = "plan", result = []) {
  if (typeof value === "string" && value.startsWith("REPLACE_WITH_")) result.push({ location, value });
  else if (Array.isArray(value)) value.forEach((item, index) => unresolvedIntegrityPlaceholders(item, `${location}[${index}]`, result));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) unresolvedIntegrityPlaceholders(item, `${location}.${key}`, result);
  }
  return result;
}

async function numericIntegrityStatus(requirementsPath) {
  const requirements = await readJsonFile(requirementsPath, "Spreadsheet requirements");
  validateRequirements(requirements, requirementsPath);
  if (!requirements.numericIntegrity) {
    return {
      state: "not_requested",
      readyToBind: false,
      blockers: [{ code: "sources-not-prepared", message: "Requirements were not prepared with --source" }],
      next: "Run prepare with every fact-providing --source.",
    };
  }
  const evidencePath = assertInternalArtifactPath(requirements.numericIntegrity.evidence.path, "Spreadsheet source evidence");
  const planPath = assertInternalArtifactPath(requirements.numericIntegrity.plan.path, "Spreadsheet numeric-integrity plan");
  const blockers = [];
  const sourceChecks = await evaluateSourceFiles(requirements);
  for (const check of sourceChecks.filter((item) => !item.passed)) blockers.push({ code: "source-changed", ...check });
  let evidence = null;
  try {
    evidence = validateSourceEvidence(await readJsonFile(evidencePath, "Spreadsheet source evidence"));
    const evidenceHash = await fileSha256(evidencePath);
    if (requirements.numericIntegrity.state === "bound" && requirements.numericIntegrity.evidence.sha256
      && evidenceHash !== requirements.numericIntegrity.evidence.sha256.toLowerCase()) {
      blockers.push({ code: "evidence-binding-stale", expected: requirements.numericIntegrity.evidence.sha256, actual: evidenceHash });
    }
  } catch (error) {
    blockers.push({ code: "evidence-invalid", message: error instanceof Error ? error.message : String(error) });
  }
  let rawPlan = null;
  let plan = null;
  let placeholders = [];
  try {
    rawPlan = await readJsonFile(planPath, "Spreadsheet numeric-integrity plan");
    placeholders = unresolvedIntegrityPlaceholders(rawPlan);
    if (rawPlan.draft === true) blockers.push({ code: "plan-draft", message: "The generated plan is still marked draft" });
    if (placeholders.length > 0) blockers.push({ code: "plan-placeholders", placeholders });
    plan = validateNumericIntegrityPlan(rawPlan);
    const frozenSources = new Set((requirements.sourceFiles ?? []).map((item) => path.resolve(item.path)));
    const unfrozenSources = planSourcePaths(plan).filter((sourcePath) => !frozenSources.has(sourcePath));
    if (unfrozenSources.length > 0) blockers.push({ code: "unfrozen-plan-sources", sources: unfrozenSources });
    if (requirements.numericIntegrity.state === "bound" && requirements.numericIntegrity.plan.sha256) {
      const planHash = await fileSha256(planPath);
      if (planHash !== requirements.numericIntegrity.plan.sha256.toLowerCase()) {
        blockers.push({ code: "plan-binding-stale", expected: requirements.numericIntegrity.plan.sha256, actual: planHash });
      }
    }
  } catch (error) {
    blockers.push({ code: "plan-invalid", message: error instanceof Error ? error.message : String(error) });
  }
  const readyToBind = blockers.length === 0 && requirements.numericIntegrity.state === "prepared";
  const bound = blockers.length === 0 && requirements.numericIntegrity.state === "bound";
  return {
    state: requirements.numericIntegrity.state,
    readyToBind,
    bound,
    requirements: requirementsPath,
    evidence: evidence ? { path: evidencePath, sources: evidence.sources.map((source) => ({ id: source.id, path: source.path })) } : { path: evidencePath },
    plan: {
      path: planPath,
      draft: rawPlan?.draft ?? null,
      operations: plan?.operations?.map((operation) => ({
        id: operation.id,
        type: operation.type,
        inputs: (operation.inputs ?? []).map((input) => input.operation ? { operation: input.operation } : { source: input.source }),
        output: operation.output ? {
          sheet: operation.output.sheet,
          range: operation.output.range,
          fields: Object.keys(operation.output.columns ?? {}),
        } : null,
      })) ?? [],
    },
    blockers,
    next: readyToBind
      ? `Run integrity-bind --requirements ${requirementsPath}.`
      : bound
        ? "Build the candidate; its SHA-bound attestation will carry the numeric-integrity result through QA and delivery."
        : "Resolve only the listed blockers, then rerun integrity-status. Do not inspect the CLI implementation.",
  };
}

async function commandIntegrityStatus(options) {
  const requirementsPath = assertInternalArtifactPath(requireOption(options, "requirements"), "Spreadsheet requirements");
  const status = await numericIntegrityStatus(requirementsPath);
  await emitReport({ status: "ok", numericIntegrity: status }, options.report && String(options.report));
  return status;
}

async function commandIntegrityBind(options) {
  const requirementsPath = assertInternalArtifactPath(requireOption(options, "requirements"), "Spreadsheet requirements");
  const requirements = await readJsonFile(requirementsPath, "Spreadsheet requirements");
  validateRequirements(requirements, requirementsPath);
  if (!requirements.numericIntegrity) throw new Error("Requirements were not prepared with --source");
  const evidencePath = assertInternalArtifactPath(
    options.evidence ? requireOption(options, "evidence") : requirements.numericIntegrity.evidence.path,
    "Spreadsheet source evidence",
  );
  const planPath = assertInternalArtifactPath(
    options.plan ? requireOption(options, "plan") : requirements.numericIntegrity.plan.path,
    "Spreadsheet numeric-integrity plan",
  );
  const evidence = validateSourceEvidence(await readJsonFile(evidencePath, "Spreadsheet source evidence"));
  const rawPlan = await readJsonFile(planPath, "Spreadsheet numeric-integrity plan");
  const placeholders = unresolvedIntegrityPlaceholders(rawPlan);
  if (rawPlan.draft === true || placeholders.length > 0) {
    throw blocked("numeric-integrity-plan-draft", "The generated numeric-integrity plan is unfinished", {
      plan: planPath,
      draft: rawPlan.draft === true,
      placeholders,
      next: "Replace every REPLACE_WITH_* placeholder, verify exact source/output ranges and field semantics, set draft=false, then run integrity-status before integrity-bind.",
    });
  }
  const plan = validateNumericIntegrityPlan(rawPlan);
  const frozenSources = new Map((requirements.sourceFiles ?? []).map((item) => [path.resolve(item.path), item.sha256.toLowerCase()]));
  const evidenceSources = new Map(evidence.sources.map((item) => [path.resolve(item.path), item.sha256.toLowerCase()]));
  for (const [sourcePath, expectedHash] of frozenSources.entries()) {
    if (evidenceSources.get(sourcePath) !== expectedHash) throw new Error(`Source evidence does not match frozen source: ${sourcePath}`);
  }
  for (const sourcePath of planSourcePaths(plan)) {
    if (!frozenSources.has(sourcePath)) throw new Error(`Integrity plan references an unfrozen source: ${sourcePath}`);
  }
  const imageFactIds = new Set(evidence.imageFacts.map((fact) => fact.id));
  for (const operation of plan.operations) {
    if (operation.type !== "ocr") continue;
    for (const reference of operation.facts) {
      if (!imageFactIds.has(reference.evidenceId)) throw new Error(`OCR operation '${operation.id}' references missing image fact '${reference.evidenceId}'`);
    }
  }
  requirements.numericIntegrity = {
    ...requirements.numericIntegrity,
    state: "bound",
    evidence: { path: evidencePath, sha256: await fileSha256(evidencePath) },
    plan: { path: planPath, sha256: await fileSha256(planPath) },
  };
  requirements.sourceBacked = true;
  requirements.sourceBackedSheets = planOutputSheets(plan);
  const integrityFormulaRanges = [];
  for (const operation of plan.operations) {
    if (operation.type !== "formula") continue;
    const outputBounds = parseRangeReference(operation.output.range);
    for (const calculation of operation.calculations ?? []) {
      if (calculation.requireFormula === false) continue;
      const column = operation.output.columns[calculation.target].toUpperCase();
      integrityFormulaRanges.push({
        sheet: operation.output.sheet,
        range: `${column}${outputBounds.startRow}:${column}${outputBounds.endRow}`,
      });
    }
  }
  const existingFormulaRangeKeys = new Set((requirements.requiredFormulaRanges ?? []).map((item) => `${item.sheet}\u001f${item.range}`));
  requirements.requiredFormulaRanges = [
    ...(requirements.requiredFormulaRanges ?? []),
    ...integrityFormulaRanges.filter((item) => !existingFormulaRangeKeys.has(`${item.sheet}\u001f${item.range}`)),
  ];
  validateRequirements(requirements, requirementsPath);
  await writeJson(requirementsPath, requirements);
  const report = {
    status: "ok",
    requirements: requirementsPath,
    numericIntegrity: requirements.numericIntegrity,
    sourceBackedSheets: requirements.sourceBackedSheets,
    operations: plan.operations.map((operation) => ({ id: operation.id, type: operation.type })),
    next: "Build the candidate once; QA and delivery will reuse its SHA-bound audit attestation.",
  };
  if (!options.quiet) await emitReport(report, options.report && String(options.report));
  else if (options.report) await writeJson(String(options.report), report);
}

async function commandTaskStatus(options) {
  const requirementsPath = assertInternalArtifactPath(requireOption(options, "requirements"), "Spreadsheet requirements");
  const requirements = validateRequirements(await readJsonFile(requirementsPath, "Spreadsheet requirements"), requirementsPath);
  const taskRoot = path.dirname(path.dirname(requirementsPath));
  const candidatePath = path.join(taskRoot, "tmp", "candidate.xlsx");
  const qaReportPath = path.join(path.dirname(requirementsPath), "visual-review.json");
  const attestationPath = attestationPathFor(requirementsPath, candidatePath);
  const finalPath = requirements.task?.finalOutput ?? null;
  const blockers = [];
  let state = "prepared";
  let candidateReady = false;
  let qaReady = false;
  let next = `Build the candidate at ${candidatePath}.`;
  if (requirements.numericIntegrity?.state === "prepared") {
    blockers.push({
      code: "numeric-lineage-needed",
      message: "Register source-to-output lineage once in the builder with helpers.integrity.register; build will bind it automatically.",
    });
  }
  if (await pathExists(candidatePath)) {
    if (await pathExists(attestationPath)) {
      try {
        await loadVerifiedSpreadsheetAttestation(attestationPath, candidatePath, requirementsPath);
        state = "built";
        candidateReady = true;
        blockers.length = 0;
        next = `Run qa-init --input ${candidatePath} --requirements ${requirementsPath} --report ${qaReportPath}.`;
      } catch (error) {
        blockers.push({ code: "stale-attestation", message: error instanceof Error ? error.message : String(error) });
        next = "Rebuild once to refresh the candidate and its audit attestation.";
      }
    } else {
      blockers.push({ code: "attestation-missing", message: "The candidate has no v2 audit attestation" });
      next = "Rebuild once; do not run audit separately.";
    }
  }
  if (await pathExists(qaReportPath)) {
    try {
      const qa = await readJsonFile(qaReportPath, "Spreadsheet visual review report");
      await assertQaBindings(qa, qaReportPath);
      if (qa.status === "ok") {
        state = "reviewed";
        qaReady = candidateReady;
        blockers.length = 0;
        next = `Run deliver with the unchanged candidate and QA report ${qaReportPath}.`;
      }
    } catch (error) {
      blockers.push({ code: "qa-stale", message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (finalPath && await pathExists(finalPath)) {
    if (qaReady && await fileSha256(finalPath) === await fileSha256(candidatePath)) {
      state = "delivered";
      blockers.length = 0;
      next = "Return the delivered workbook; no more validation commands are needed.";
    } else {
      blockers.push({
        code: "unverified-final-output",
        message: "A file exists at the final path, but it is not bound to the current reviewed candidate.",
      });
      next = qaReady
        ? "Move the unrelated final-path file aside, then run deliver."
        : next;
    }
  }
  await emitReport({
    status: "ok",
    state,
    profile: taskValidationProfile(requirements),
    dataOperation: requirements.task?.dataOperation ?? "legacy",
    paths: { requirements: requirementsPath, candidate: candidatePath, attestation: attestationPath, qa: qaReportPath, final: finalPath },
    blockers,
    next,
  }, options.report && String(options.report));
}

function capabilitiesReport() {
  return {
    status: "ok",
    protocolVersion: 2,
    resultStatuses: RESULT_STATUSES,
    capabilityStates: CAPABILITY_STATES,
    outputPolicy: {
      taskSetupCommand: "prepare",
      mutationOutputsAreInternalCandidates: true,
      finalOutputRequiresCommand: "deliver",
      deliveryRequiresMatchingQaSha256: true,
      deliveryRequiresScopedProjectGuard: true,
      sourceReplacement: "blocked",
      existingOutputsBlockedByDefault: true,
    },
    stylePolicy: {
      modes: [...STYLE_MODES],
      workbookTypes: [...WORKBOOK_TYPES],
      defaultForNewWorkbook: "neutral-built-in",
      genericProfessionalLanguageActivatesColorTheme: false,
      neutralDataWorkbookAllowsDecorativeTitle: false,
    },
    operations: {
      inspect: { status: "supported", formats: ["xlsx", "xls", "csv", "tsv"] },
      createAndEdit: {
        status: "supported",
        command: "build",
        existingWorkbookRoundTrip: "partial",
        reason: "Existing workbooks with charts, pivots, drawings, external links, connections, macros, signatures, or active content are unsafe for a generic ExcelJS round trip.",
      },
      nativeCharts: { status: "supported", types: ["line", "column", "bar"], helper: "addNativeChart" },
      rasterImages: { status: "supported", formats: ["png", "jpeg", "webp", "tiff"], helper: "addImage" },
      scatterAreaComboPieCharts: { status: "fallback", command: "fallback-patch" },
      pivotTablesExternalConnectionsPowerQuery: { status: "unsupported", fallback: "Create a companion workbook without mutating the source package." },
      macrosSignaturesEncryptionActiveX: { status: "blocked" },
      controlledFallback: { status: "supported", command: "fallback-patch", directUntrackedPackageMutation: "blocked" },
      qa: { status: "supported", commands: ["qa-init", "qa-complete"], adaptiveReview: true },
      delivery: { status: "supported", command: "deliver", candidateDigestBinding: true, repeatedAudit: false },
      numericIntegrity: {
        status: "supported",
        protocol: NUMERIC_INTEGRITY_PROTOCOL,
        operations: ["copy", "union", "join", "aggregate", "formula", "ocr"],
        fixedPointDecimal: true,
        rowExpressionInvariants: true,
        imageEvidence: {
          status: "supported",
          automaticRecognition: "external-observations",
          independentConsensus: true,
          explicitUserConfirmation: true,
          unverifiedDelivery: "blocked",
        },
        sourceBinding: "sha256",
        sourceNormalization: { fallback: "LibreOffice", lineage: "origin-and-derived-sha256", location: "PILOTDECK_WORK_DIR" },
        planScaffold: { command: "integrity-scaffold", bindsFrozenSourcePaths: true, draftMustBeResolved: true },
        planStatus: { command: "integrity-status", conciseBlockers: true, implementationInspection: "unnecessary" },
        deliveryBlocking: true,
      },
    },
  };
}

async function commandCapabilities(options = {}) {
  const full = capabilitiesReport();
  if (options.full) {
    await emitReport(full);
    return;
  }
  if (options.feature) {
    const feature = requireOption(options, "feature");
    if (!Object.hasOwn(full.operations, feature)) throw unsupported("capability-not-found", `No capability is declared for '${feature}'`, { available: Object.keys(full.operations) });
    await emitReport({ status: "ok", protocolVersion: full.protocolVersion, feature, capability: full.operations[feature] });
    return;
  }
  await emitReport({
    status: "ok",
    protocolVersion: full.protocolVersion,
    profiles: VALIDATION_PROFILES,
    dataOperations: DATA_OPERATIONS,
    workflow: ["prepare", "build", "qa-init", "qa-complete", "deliver"],
    auditPolicy: "Build audits once and writes a SHA-bound attestation reused by QA and delivery.",
    next: "Query schema only for the command you are about to use; add --full only for capability debugging.",
  });
}

function schemaFor(command) {
  const schemas = {
    prepare: {
      required: ["final-out"],
      enums: {
        "workbook-type": [...WORKBOOK_TYPES],
        "style-mode": [...STYLE_MODES],
        "visual-review-mode": [...VISUAL_REVIEW_MODES],
        "validation-profile": VALIDATION_PROFILES,
        "data-operation": DATA_OPERATIONS,
      },
      repeatable: ["source", "visual-sheet", "allow-accent-color"],
      optional: ["overwrite", "clear-sources"],
      overwriteBehavior: "Preserves the scoped project guard and existing frozen sources unless --source replaces them or --clear-sources explicitly removes them; registered builder lineage is rebound by the next build.",
    },
    requirements: {
      type: "object",
      allowedKeys: [...REQUIREMENT_KEYS],
      task: { protocols: [TASK_PROTOCOL, LEGACY_TASK_PROTOCOL], profiles: VALIDATION_PROFILES, dataOperations: DATA_OPERATIONS, workbookTypes: [...WORKBOOK_TYPES], styleModes: [...STYLE_MODES], visualReviewModes: [...VISUAL_REVIEW_MODES] },
    },
    "numeric-integrity": {
      protocol: NUMERIC_INTEGRITY_PROTOCOL,
      mode: ["strict"],
      draft: { type: "boolean", scaffoldValue: true, bindingRequiresValue: false },
      operations: {
        supported: ["copy", "union", "join", "aggregate", "formula", "ocr"],
        structuredRequired: ["id", "type", "fields", "inputs", "output"],
        ocrRequired: ["id", "type", "fields", "facts", "output.sheet"],
        regionRequired: ["sheet", "range", "columns"],
        inputReference: "Each input references exactly one absolute frozen source or an earlier operation; operation inputs reuse that operation's exact output sheet/range/columns.",
        fieldTypes: ["decimal", "integer", "number", "identifier", "string", "boolean", "date"],
      },
      ocrPolicy: {
        required: ["minConfidence", "minIndependentObservations", "allowExplicitUserConfirmation"],
        note: "The runtime binds image regions and observations; it does not bundle an OCR model.",
      },
    },
    "integrity-scaffold": {
      required: ["requirements", "operation"],
      enums: { operation: ["copy", "union", "join", "aggregate", "formula", "ocr"] },
      optional: ["id", "source-id", "from-operation", "append", "overwrite", "report"],
      repeatable: ["source-id"],
      note: "Writes a source-bound draft. Use --source-id to select frozen inputs and --append --from-operation to build a trusted multi-step DAG without using the candidate as a source.",
    },
    "integrity-status": {
      required: ["requirements"],
      optional: ["report"],
      note: "Returns concise plan, binding, source, placeholder, range, and dependency blockers plus the exact next action. Use it instead of reading CLI implementation code.",
    },
    status: {
      required: ["requirements"],
      optional: ["report"],
      note: "Returns the compact prepared/built/reviewed/delivered state and exactly one next action without reading runtime implementation.",
    },
    "qa-complete": {
      required: ["report", "reviews"],
      reviewsShape: { reviews: [{ sheet: "Summary", page: 1, status: "passed", notes: "Specific visual observation" }] },
      note: "Records every selected adaptive-review page in one command and finalizes the SHA-bound review without rerunning the audit.",
    },
    "native-chart": {
      required: ["sheet", "type", "categories", "series", "anchor"],
      types: ["line", "column", "bar"],
      seriesRequired: ["name", "values"],
      anchorRequired: ["from", "to"],
    },
    image: {
      helper: "await helpers.addImage(workbook, spec)",
      required: ["sheet", "path", "anchor"],
      formats: ["png", "jpeg", "webp", "tiff"],
      anchorRequired: ["from", "to"],
    },
    "fallback-patch": {
      required: ["input", "script", "out", "manifest", "reason", "allow-part"],
      repeatable: ["allow-part"],
      scriptContract: "node patch.mjs --package-dir <temporary-unpacked-xlsx>",
    },
  };
  const schema = schemas[command];
  if (!schema) throw unsupported("schema-not-found", `No spreadsheet schema is declared for '${command}'`, { available: Object.keys(schemas) });
  return { status: "ok", command, schema };
}

async function commandSchema(options) {
  await emitReport(schemaFor(requireOption(options, "command")));
}

function safePackageEntryName(entryName) {
  const normalized = entryName.replaceAll("\\", "/");
  return normalized
    && !normalized.startsWith("/")
    && !normalized.split("/").includes("..")
    && !path.isAbsolute(normalized);
}

async function unpackXlsxToDirectory(inputPath, packageDir) {
  const zip = await JSZip.loadAsync(await fs.readFile(inputPath));
  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (!safePackageEntryName(entryName)) throw blocked("unsafe-package-path", `Unsafe XLSX package entry: ${entryName}`);
    const target = path.join(packageDir, ...entryName.split("/"));
    if (entry.dir) await fs.mkdir(target, { recursive: true });
    else {
      await ensureParent(target);
      await fs.writeFile(target, await entry.async("nodebuffer"));
    }
  }
}

async function packageFileHashes(packageDir) {
  const hashes = new Map();
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw blocked("fallback-symlink", "Fallback package scripts may not create symbolic links");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(packageDir, absolute).split(path.sep).join("/");
        if (!safePackageEntryName(relative)) throw blocked("unsafe-package-path", `Unsafe fallback output path: ${relative}`);
        hashes.set(relative, await fileSha256(absolute));
      }
    }
  }
  await visit(packageDir);
  return hashes;
}

function packageChanges(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

function globPatternMatches(pattern, value) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${source}$`).test(value);
}

async function repackDirectoryToXlsx(packageDir, outputPath) {
  const zip = new JSZip();
  const hashes = await packageFileHashes(packageDir);
  for (const entryName of [...hashes.keys()].sort()) {
    zip.file(entryName, await fs.readFile(path.join(packageDir, ...entryName.split("/"))));
  }
  await ensureParent(outputPath);
  await fs.writeFile(outputPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function commandFallbackPatch(options) {
  const inputPath = path.resolve(requireOption(options, "input"));
  const scriptPath = assertInternalArtifactPath(requireOption(options, "script"), "Spreadsheet fallback script");
  const outputPath = assertInternalArtifactPath(requireOption(options, "out"), "Spreadsheet fallback candidate");
  const manifestPath = assertInternalArtifactPath(requireOption(options, "manifest"), "Spreadsheet fallback manifest");
  const reason = requireOption(options, "reason").trim();
  const allowParts = optionValues(options, "allow-part");
  if (!reason) throw new Error("--reason must explain the missing standard capability");
  if (allowParts.length === 0) throw new Error("fallback-patch requires at least one --allow-part");
  if (workbookExtension(inputPath) !== ".xlsx" || workbookExtension(outputPath) !== ".xlsx") throw new Error("fallback-patch requires .xlsx input and output");
  if (!(await pathExists(inputPath))) throw new Error(`Fallback input not found: ${inputPath}`);
  if (!(await pathExists(scriptPath))) throw new Error(`Fallback script not found: ${scriptPath}`);
  if (!/[.]mjs$/i.test(scriptPath)) throw new Error("Fallback scripts must be JavaScript ES modules (.mjs)");
  if (pathsReferToSameLocation(inputPath, outputPath)) throw new Error("Fallback output must be distinct from input");
  if (await pathExists(outputPath)) throw blocked("fallback-output-exists", "Refusing to overwrite an existing fallback candidate", { output: outputPath });

  const packageInfo = await inspectPackage(inputPath);
  const forbiddenFeatures = ["macros", "activeX", "signatures", "embeddings"].filter((feature) => packageInfo.features[feature] > 0);
  if (forbiddenFeatures.length > 0) {
    throw blocked("fallback-active-content", "Controlled fallback cannot mutate a workbook containing active, signed, or embedded content", { features: forbiddenFeatures });
  }
  const forbiddenPart = /^(?:_xmlsignatures\/|xl\/(?:vbaProject[.]bin|activeX\/|embeddings\/))/i;
  if (allowParts.some((pattern) => forbiddenPart.test(pattern.replaceAll("*", "")))) {
    throw blocked("fallback-forbidden-part", "The fallback allowlist includes a forbidden active-content part", { allowParts });
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-fallback-"));
  const packageDir = path.join(tempRoot, "package");
  const stagedOutput = path.join(tempRoot, "candidate.xlsx");
  let manifest;
  try {
    await fs.mkdir(packageDir, { recursive: true });
    await unpackXlsxToDirectory(inputPath, packageDir);
    const before = await packageFileHashes(packageDir);
    const safeEnvironment = {};
    for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR"]) {
      if (process.env[key]) safeEnvironment[key] = process.env[key];
    }
    let scriptResult;
    try {
      scriptResult = await execFileAsync(process.execPath, [scriptPath, "--package-dir", packageDir], {
        cwd: path.dirname(scriptPath),
        env: safeEnvironment,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      manifest = {
        status: "error",
        protocol: "pilotdeck-spreadsheet-fallback/v1",
        reason,
        input: inputPath,
        script: scriptPath,
        scriptSha256: await fileSha256(scriptPath),
        allowParts,
        error: error instanceof Error ? error.message : String(error),
        stdout: String(error?.stdout ?? "").slice(0, 8000),
        stderr: String(error?.stderr ?? "").slice(0, 8000),
      };
      await writeJson(manifestPath, manifest);
      throw new Error(`Fallback script failed: ${manifest.error}`);
    }
    const after = await packageFileHashes(packageDir);
    const changedParts = packageChanges(before, after);
    const outsideAllowlist = changedParts.filter((name) => !allowParts.some((pattern) => globPatternMatches(pattern, name)));
    const forbiddenChanges = changedParts.filter((name) => forbiddenPart.test(name));
    if (outsideAllowlist.length > 0 || forbiddenChanges.length > 0) {
      manifest = {
        status: "blocked",
        protocol: "pilotdeck-spreadsheet-fallback/v1",
        reason,
        input: inputPath,
        script: scriptPath,
        scriptSha256: await fileSha256(scriptPath),
        allowParts,
        changedParts,
        outsideAllowlist,
        forbiddenChanges,
        stdout: String(scriptResult.stdout ?? "").slice(0, 8000),
        stderr: String(scriptResult.stderr ?? "").slice(0, 8000),
      };
      await writeJson(manifestPath, manifest);
      throw blocked("fallback-scope-exceeded", "Fallback changed XLSX parts outside its declared allowlist", manifest);
    }
    if (changedParts.length === 0) {
      manifest = {
        status: "partial",
        protocol: "pilotdeck-spreadsheet-fallback/v1",
        reason,
        input: inputPath,
        script: scriptPath,
        scriptSha256: await fileSha256(scriptPath),
        allowParts,
        changedParts,
        next: "Correct the fallback script; a no-op is not success.",
      };
      await writeJson(manifestPath, manifest);
      if (!options.quiet) await emitReport(manifest);
      return;
    }
    await repackDirectoryToXlsx(packageDir, stagedOutput);
    const validation = await inspectPackage(stagedOutput);
    if (validation.compatibility.status !== "ok") throw blocked("fallback-invalid-package", "Fallback produced invalid spreadsheet package relationships", { issues: validation.compatibility.issues });
    const workbook = await loadXlsx(stagedOutput);
    if (workbook.worksheets.length === 0) throw new Error("Fallback output has no worksheets");
    await replaceFileAtomically(stagedOutput, outputPath);
    manifest = {
      status: "ok",
      protocol: "pilotdeck-spreadsheet-fallback/v1",
      reason,
      input: inputPath,
      inputSha256: await fileSha256(inputPath),
      script: scriptPath,
      scriptSha256: await fileSha256(scriptPath),
      allowParts,
      changedParts,
      output: outputPath,
      outputSha256: await fileSha256(outputPath),
      validation: validation.compatibility,
      stdout: String(scriptResult.stdout ?? "").slice(0, 8000),
      stderr: String(scriptResult.stderr ?? "").slice(0, 8000),
    };
    await writeJson(manifestPath, manifest);
    if (!options.quiet) await emitReport(manifest);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function workbookRequiresRequirements(workbook, nativeCharts, facts) {
  if (workbook.worksheets.length > 1 || facts.formulaCount > 0 || nativeCharts.length > 0) return true;
  return workbook.worksheets.some((worksheet) => (
    tableSummaries(worksheet).length > 0
    || (worksheet.conditionalFormattings?.length ?? 0) > 0
    || Object.keys(worksheet.dataValidations?.model ?? {}).length > 0
  ));
}

async function replaceFileAtomically(sourcePath, outputPath) {
  await ensureParent(outputPath);
  const resolvedOutput = path.resolve(outputPath);
  const temporaryOutput = path.join(path.dirname(resolvedOutput), `.${path.basename(resolvedOutput)}.${process.pid}.${Date.now()}.tmp`);
  const backupOutput = `${temporaryOutput}.bak`;
  await fs.copyFile(sourcePath, temporaryOutput);
  try {
    await fs.rename(temporaryOutput, resolvedOutput);
  } catch (error) {
    const replaceBlocked = process.platform === "win32" && ["EEXIST", "EPERM"].includes(error?.code) && await pathExists(resolvedOutput);
    if (!replaceBlocked) {
      await fs.rm(temporaryOutput, { force: true });
      throw error;
    }
    await fs.rename(resolvedOutput, backupOutput);
    try {
      await fs.rename(temporaryOutput, resolvedOutput);
      await fs.rm(backupOutput, { force: true });
    } catch (replaceError) {
      if (await pathExists(backupOutput)) await fs.rename(backupOutput, resolvedOutput);
      await fs.rm(temporaryOutput, { force: true });
      throw replaceError;
    }
  }
}

async function commandBuildCore(options) {
  const builderPath = assertInternalArtifactPath(
    requireOption(options, "builder"),
    "Spreadsheet builder",
  );
  const outputPath = assertInternalArtifactPath(requireOption(options, "out"), "Spreadsheet candidate");
  const inputPath = options.input ? requireOption(options, "input") : null;
  const outputExtension = assertSupportedOutput(outputPath);
  const requirementsPath = options.requirements
    ? assertInternalArtifactPath(String(options.requirements), "Spreadsheet requirements")
    : null;

  if (inputPath) {
    assertSupportedInput(inputPath);
    if (pathsReferToSameLocation(inputPath, outputPath)) {
      throw new Error("Refusing to overwrite the input spreadsheet. Choose a distinct --out path.");
    }
    if (workbookExtension(inputPath) === ".xlsx") {
      const packageInfo = await inspectPackage(inputPath);
      if (packageInfo.unsafeForRoundTrip && !options["allow-risky-roundtrip"]) {
        const names = packageInfo.roundTripRisks.map((risk) => `${risk.feature}(${risk.count})`).join(", ");
        throw blocked(
          "unsafe-workbook-round-trip",
          `Input workbook contains objects that are unsafe for an ExcelJS round trip: ${names}`,
          { risks: packageInfo.roundTripRisks, next: "Preserve the source and create a companion workbook, or obtain explicit approval for the listed losses." },
        );
      }
    }
  }

  const { workbook, sheetName, nativeCharts, insertedImages, requirements: builderRequirements, integrityPlan } = await runStage(
    "builder_execution",
    () => buildFromBuilder(builderPath, inputPath),
  );
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.calcProperties.forceFullCalc = true;
  let requirements = await runStage(
    "requirements_validation",
    () => resolveRequirements(
      requirementsPath,
      builderRequirements,
    ),
  );
  if (integrityPlan) {
    if (!requirementsPath || !requirements?.numericIntegrity) {
      throw blocked("unprepared-integrity-plan", "The builder registered numeric lineage but the task has no prepared source bindings", {
        next: "Run prepare with every fact source and pass its requirements path to build.",
      });
    }
    if (requirements.numericIntegrity.state === "prepared") {
      const planPath = assertInternalArtifactPath(requirements.numericIntegrity.plan.path, "Spreadsheet numeric-integrity plan");
      await writeJson(planPath, { ...integrityPlan, draft: false });
      await commandIntegrityBind({ requirements: requirementsPath, plan: planPath, quiet: true });
      requirements = await runStage("requirements_validation", () => resolveRequirements(requirementsPath, builderRequirements));
    } else {
      const registeredHash = crypto.createHash("sha256").update(`${JSON.stringify({ ...integrityPlan, draft: false }, null, 2)}\n`).digest("hex");
      if (registeredHash !== requirements.numericIntegrity.plan.sha256?.toLowerCase()) {
        throw blocked("builder-integrity-plan-changed", "The builder's registered numeric lineage differs from the bound plan", {
          next: "Re-run prepare --overwrite to return integrity to prepared, then rebuild once so the registered plan can be rebound.",
        });
      }
    }
  }
  const typographyNormalization = await runStage(
    "typography_normalization",
    async () => normalizeCjkTypography(workbook, requirements),
  );
  await runStage("builder_validation", async () => validateWorkbookForSerialization(workbook, nativeCharts));
  const facts = collectWorkbookFacts(workbook);
  if (requirements?.task?.protocol === TASK_PROTOCOL && requirementsPath) {
    let requirementsChanged = false;
    if (requirements.task.validationProfile === "fast"
      && requirements.task.dataOperation === "create"
      && (facts.formulaCount > 0 || nativeCharts.length > 0)) {
      requirements.task.validationProfile = "standard";
      requirements.task.profileReasons = [
        ...(requirements.task.profileReasons ?? []),
        `Build output uses ${facts.formulaCount > 0 ? "formulas" : "native charts"}; validation was automatically escalated to standard.`,
      ];
      requirementsChanged = true;
    }
    if ((requirements.requiredSheets?.length ?? 0) === 0) {
      requirements.requiredSheets = workbook.worksheets.map((worksheet) => worksheet.name);
      requirementsChanged = true;
    }
    if (taskValidationProfile(requirements) !== "strict"
      && facts.formulaCount > 0
      && requirements.minFormulaCount === undefined
      && (requirements.requiredFormulaRanges?.length ?? 0) === 0) {
      requirements.minFormulaCount = facts.formulaCount;
      requirementsChanged = true;
    }
    if (requirementsChanged) {
      validateRequirements(requirements, requirementsPath);
      await writeJson(requirementsPath, requirements);
    }
  }
  assertNumericIntegrityBound(requirements);
  await runStage("requirements_preflight", () => validateWorkbookRequirementsPreflight(workbook, requirements));

  if (requirements?.task?.input) {
    if (!inputPath || !pathsReferToSameLocation(inputPath, requirements.task.input.path)) {
      throw blocked("prepared-input-mismatch", "The build input does not match the workbook frozen by prepare", {
        prepared: requirements.task.input.path,
        actual: inputPath ? path.resolve(inputPath) : null,
      });
    }
  } else if (inputPath && requirements?.task) {
    throw blocked("unprepared-input", "The task was prepared as a new workbook but build received an existing input", { input: path.resolve(inputPath) });
  }

  if (outputExtension === ".xlsx" && workbookRequiresRequirements(workbook, nativeCharts, facts) && !requirements) {
    throw new Error("Non-trivial XLSX builds require verifiable requirements. Return requirements from the builder or pass --requirements.");
  }

  if (outputExtension === ".csv" || outputExtension === ".tsv") {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-delimited-build-"));
    try {
      const stagedPath = path.join(tempRoot, `candidate${outputExtension}`);
      await exportDelimited(workbook, stagedPath, options.sheet ? String(options.sheet) : sheetName, options.encoding ? String(options.encoding) : "utf8-bom");
      const audit = await auditDelimited(stagedPath);
      await replaceFileAtomically(stagedPath, outputPath);
      const report = { status: audit.status, output: path.resolve(outputPath), format: outputExtension.slice(1), audit };
      if (!options.quiet) await emitReport(report, options.report && String(options.report));
      else if (options.report) await writeJson(String(options.report), report);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    return;
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-build-"));
  const rawPath = path.join(tempRoot, "raw.xlsx");
  const stagedPath = path.join(tempRoot, "candidate.xlsx");
  let audit = null;
  try {
    await runStage("workbook_serialization", () => workbook.xlsx.writeFile(rawPath));
    let recalculated = false;
    if (facts.formulaCount > 0) {
      await runStage("formula_recalculation", () => recalculateWorkbook(rawPath, stagedPath));
      recalculated = true;
    } else {
      await fs.copyFile(rawPath, stagedPath);
    }
    const chartResult = await runStage("chart_injection", () => injectNativeCharts(stagedPath, nativeCharts, { JSZip, loadXlsx }));
    audit = await runStage("audit", () => auditXlsx(stagedPath, requirements));
    await runStage("numeric_integrity_report", () => persistNumericIntegrityReport(requirements, audit.numericIntegrity));
    if (audit.status === "error") {
      throw new SpreadsheetStageError(
        "audit",
        `Workbook failed formula, structure, or requirement coverage audit; the candidate output was not updated. ${summarizeAuditFailures(audit)}`,
      );
    }
    await replaceFileAtomically(stagedPath, outputPath);
    const attestation = requirementsPath
      ? await runStage("attestation", () => writeSpreadsheetAttestation({
        candidatePath: outputPath,
        requirementsPath,
        builderPath,
        requirements,
        audit: { ...audit, path: path.resolve(outputPath) },
      }))
      : null;
    const reportedAudit = { ...audit, path: path.resolve(outputPath) };
    const report = {
      status: audit.status,
      output: path.resolve(outputPath),
      formulaCount: facts.formulaCount,
      recalculated,
      nativeCharts: chartResult,
      insertedImages,
      typographyNormalization,
      requirements: reportedAudit.coverage,
      audit: reportedAudit,
      attestation: attestation ? { path: attestation.path, sha256: attestation.sha256 } : null,
    };
    if (!options.quiet) await emitReport(report, options.report && String(options.report));
    else if (options.report) await writeJson(String(options.report), report);
  } catch (error) {
    const failedDir = assertInternalArtifactPath(`${outputPath}.failed`, "Failed spreadsheet build artifacts");
    let failedArtifacts = null;
    try {
      await fs.rm(failedDir, { recursive: true, force: true });
      await fs.mkdir(failedDir, { recursive: true });
      const files = {};
      if (await pathExists(rawPath)) {
        files.raw = path.join(failedDir, "raw.xlsx");
        await fs.copyFile(rawPath, files.raw);
      }
      if (await pathExists(stagedPath)) {
        files.staged = path.join(failedDir, "staged.xlsx");
        await fs.copyFile(stagedPath, files.staged);
      }
      if (audit) {
        files.audit = path.join(failedDir, "audit.json");
        await writeJson(files.audit, audit);
      }
      failedArtifacts = { directory: failedDir, files };
    } catch (artifactError) {
      failedArtifacts = { directory: failedDir, error: artifactError instanceof Error ? artifactError.message : String(artifactError) };
    }
    const report = {
      status: "error",
      output: path.resolve(outputPath),
      outputUpdated: false,
      stage: error instanceof SpreadsheetStageError ? error.stage : "build",
      error: error instanceof Error ? error.message : String(error),
      ...(audit ? { audit, failureSummary: summarizeAuditFailures(audit) } : {}),
      failedArtifacts,
    };
    if (failedArtifacts?.directory && !failedArtifacts.error) {
      const artifactReport = path.join(failedArtifacts.directory, "report.json");
      await writeJson(artifactReport, report);
      failedArtifacts.files.report = artifactReport;
    }
    if (options.report) await writeJson(String(options.report), report);
    if (error instanceof SpreadsheetStageError) error.details = { ...error.details, report: options.report, failedArtifacts };
    throw error;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function commandBuild(options) {
  const outputPath = assertInternalArtifactPath(requireOption(options, "out"), "Spreadsheet candidate");
  const reportPath = options.report
    ? assertInternalArtifactPath(requireOption(options, "report"), "Spreadsheet build report")
    : assertInternalArtifactPath(`${outputPath}.build-report.json`, "Spreadsheet build report");
  try {
    return await commandBuildCore({ ...options, report: reportPath });
  } catch (error) {
    if (!(await pathExists(reportPath))) {
      await writeJson(reportPath, {
        status: "error",
        output: path.resolve(outputPath),
        outputUpdated: false,
        stage: error instanceof SpreadsheetStageError ? error.stage : "build",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (error instanceof SpreadsheetStageError) error.details = { ...error.details, report: reportPath };
    throw error;
  }
}

async function commandInspect(options) {
  const inputPath = requireOption(options, "input");
  const extension = assertSupportedInput(inputPath, { legacy: true });
  let report;
  if (extension === ".xls") {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-inspect-xls-"));
    try {
      const convertedPath = path.join(tempRoot, "converted.xlsx");
      await convertLegacyXls(inputPath, convertedPath);
      report = await inspectXlsx(convertedPath, options);
      report.path = path.resolve(inputPath);
      report.format = "xls";
      report.convertedForInspection = true;
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  } else {
    report = extension === ".xlsx" ? await inspectXlsx(inputPath, options) : await inspectDelimited(inputPath, options);
  }
  await emitReport(report, options.out && String(options.out));
}

async function commandAudit(options) {
  const inputPath = requireOption(options, "input");
  const extension = assertSupportedInput(inputPath);
  const requirements = await runStage(
    "requirements_validation",
    () => resolveRequirements(
      options.requirements
        ? assertInternalArtifactPath(String(options.requirements), "Spreadsheet requirements")
        : null,
    ),
  );
  const report = await runStage(
    "audit",
    () => extension === ".xlsx" ? auditXlsx(inputPath, requirements) : auditDelimited(inputPath),
  );
  await runStage("numeric_integrity_report", () => persistNumericIntegrityReport(requirements, report.numericIntegrity));
  await emitReport(report, options.out && String(options.out));
  if (report.status === "error") process.exitCode = 1;
}

async function commandConvertLegacy(options) {
  const inputPath = requireOption(options, "input");
  const outputPath = assertInternalArtifactPath(requireOption(options, "out"), "Converted spreadsheet candidate");
  const report = await convertLegacyXls(inputPath, outputPath);
  await emitReport(report, options.report && String(options.report));
}

async function commandRecalculate(options) {
  const inputPath = requireOption(options, "input");
  const outputPath = assertInternalArtifactPath(requireOption(options, "out"), "Recalculated spreadsheet candidate");
  if (workbookExtension(inputPath) !== ".xlsx" || workbookExtension(outputPath) !== ".xlsx") {
    throw new Error("recalculate accepts .xlsx input and output only");
  }
  if (pathsReferToSameLocation(inputPath, outputPath)) throw new Error("Refusing to overwrite the input workbook");
  const packageInfo = await inspectPackage(inputPath);
  if (packageInfo.unsafeForRoundTrip && !options["allow-risky-roundtrip"]) {
    const names = packageInfo.roundTripRisks.map((risk) => `${risk.feature}(${risk.count})`).join(", ");
    throw blocked(
      "unsafe-libreoffice-round-trip",
      `Input workbook contains objects that are unsafe for a LibreOffice round trip: ${names}`,
      { risks: packageInfo.roundTripRisks, next: "Preserve the source unless the user explicitly accepts the listed compatibility risks." },
    );
  }
  const result = await runStage("formula_recalculation", () => recalculateWorkbook(inputPath, outputPath));
  const audit = await runStage("audit", () => auditXlsx(outputPath));
  await emitReport({ status: audit.status, ...result, audit }, options.report && String(options.report));
  if (audit.status === "error") process.exitCode = 1;
}

function naturalPageSort(left, right) {
  const leftNumber = Number(left.match(/(\d+)(?=\.png$)/)?.[1] ?? 0);
  const rightNumber = Number(right.match(/(\d+)(?=\.png$)/)?.[1] ?? 0);
  return leftNumber - rightNumber || left.localeCompare(right);
}

async function createMontage(pagePaths, outputPath, labels = []) {
  const thumbWidth = 420;
  const thumbHeight = 560;
  const gutter = 20;
  const labelHeight = 30;
  const columns = Math.min(3, Math.max(1, pagePaths.length));
  const rows = Math.ceil(pagePaths.length / columns);
  const width = columns * (thumbWidth + gutter) + gutter;
  const height = rows * (thumbHeight + labelHeight + gutter) + gutter;
  const composites = [];

  for (let index = 0; index < pagePaths.length; index += 1) {
    const page = pagePaths[index];
    const x = gutter + (index % columns) * (thumbWidth + gutter);
    const y = gutter + Math.floor(index / columns) * (thumbHeight + labelHeight + gutter);
    const image = await sharp(page)
      .flatten({ background: "#ffffff" })
      .resize({ width: thumbWidth, height: thumbHeight, fit: "inside", background: "#ffffff" })
      .png()
      .toBuffer({ resolveWithObject: true });
    composites.push({ input: image.data, left: x + Math.floor((thumbWidth - image.info.width) / 2), top: y });
    const labelText = String(labels[index] ?? `Page ${index + 1}`).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const label = Buffer.from(`<svg width="${thumbWidth}" height="${labelHeight}"><text x="${thumbWidth / 2}" y="21" text-anchor="middle" font-family="Arial" font-size="16" fill="#334155">${labelText}</text></svg>`);
    composites.push({ input: label, left: x, top: y + thumbHeight });
  }

  await ensureParent(outputPath);
  await sharp({ create: { width, height, channels: 4, background: "#e2e8f0" } })
    .composite(composites)
    .png()
    .toFile(outputPath);
}

async function analyzeRenderedPage(pagePath) {
  const { data, info } = await sharp(pagePath).flatten({ background: "#ffffff" }).resize({ width: 480, withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let ink = 0;
  for (const value of data) if (value < 245) ink += 1;
  const pixelCount = info.width * info.height;
  const inkRatio = pixelCount > 0 ? ink / pixelCount : 0;
  return { path: path.resolve(pagePath), width: info.width, height: info.height, inkRatio, blank: inkRatio < 0.00035 };
}

async function createSingleSheetPackage(inputPath, outputPath, sheetName) {
  const zip = await JSZip.loadAsync(await fs.readFile(inputPath));
  const workbookPart = zip.file("xl/workbook.xml");
  if (!workbookPart) throw new Error("The XLSX package is missing xl/workbook.xml");
  let workbookXml = await workbookPart.async("string");
  let sheetIndex = -1;
  let selectedIndex = 0;
  workbookXml = workbookXml.replace(/<sheet\b([^>]*)\/?\s*>/gi, (match, attributes) => {
    sheetIndex += 1;
    const name = /\bname="([^"]*)"/.exec(attributes)?.[1]
      ?.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
    if (name === sheetName) selectedIndex = sheetIndex;
    const cleaned = attributes.replace(/\sstate="[^"]*"/i, "").replace(/\/\s*$/, "").trimEnd();
    return name === sheetName ? `<sheet${cleaned}/>` : "";
  });
  workbookXml = workbookXml.replace(/<workbookView\b([^>]*)\/?\s*>/i, (_match, attributes) => {
    const cleaned = attributes.replace(/\sactiveTab="[^"]*"/i, "").replace(/\/\s*$/, "").trimEnd();
    return `<workbookView${cleaned} activeTab="0"/>`;
  });
  workbookXml = workbookXml.replace(/<definedName\b([^>]*)\blocalSheetId="(\d+)"([^>]*)>([\s\S]*?)<\/definedName>/gi, (match, before, localSheetId, after, value) => {
    if (Number(localSheetId) !== selectedIndex) return "";
    return `<definedName${before}localSheetId="0"${after}>${value}</definedName>`;
  });
  zip.file("xl/workbook.xml", workbookXml);
  for (const worksheetPart of Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))) {
    const worksheetXml = await zip.file(worksheetPart).async("string");
    zip.file(worksheetPart, worksheetXml.replace(/\stabSelected="[^"]*"/gi, ""));
  }
  await fs.writeFile(outputPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function convertToXlsxForRender(inputPath, tempRoot) {
  if (workbookExtension(inputPath) === ".xlsx") return inputPath;
  if (workbookExtension(inputPath) === ".xls") {
    const outputPath = path.join(tempRoot, "legacy.xlsx");
    await convertLegacyXls(inputPath, outputPath);
    return outputPath;
  }
  const workbook = await loadDelimited(inputPath, { inferTypes: false });
  for (const worksheet of workbook.worksheets) {
    autoFitColumns(worksheet, { min: 8, max: 32 });
    worksheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  }
  const outputPath = path.join(tempRoot, "delimited.xlsx");
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

async function renderWorkbook(inputPath, outputDir, { pdfPath, montagePath, perSheet = false, sheetNames = null } = {}) {
  const renderer = findRenderer();
  if (!renderer) throw unsupported("pdf-renderer-unavailable", "No PDF renderer was found. Install pdftoppm, mutool, or ImageMagick.");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-render-"));
  try {
    const sourceDir = path.join(tempRoot, "source");
    const pdfDir = path.join(tempRoot, "pdf");
    const profileDir = path.join(tempRoot, "profile");
    await Promise.all([
      fs.mkdir(sourceDir, { recursive: true }),
      fs.mkdir(pdfDir, { recursive: true }),
      fs.mkdir(profileDir, { recursive: true }),
      fs.mkdir(outputDir, { recursive: true }),
    ]);
    for (const name of await fs.readdir(outputDir)) {
      if (/^page-?\d+\.png$/i.test(name)) await fs.rm(path.join(outputDir, name), { force: true });
    }
    const xlsxInput = await convertToXlsxForRender(inputPath, tempRoot);
    if (perSheet) {
      const workbook = await loadXlsx(xlsxInput);
      const sheetReports = [];
      const allPages = [];
      const labels = [];
      const worksheets = Array.isArray(sheetNames)
        ? sheetNames.map((name) => workbook.getWorksheet(name)).filter(Boolean)
        : workbook.worksheets;
      if (Array.isArray(sheetNames) && worksheets.length !== new Set(sheetNames).size) {
        const missing = [...new Set(sheetNames)].filter((name) => !workbook.getWorksheet(name));
        throw new Error(`Visual review references missing worksheet(s): ${missing.join(", ")}`);
      }
      for (let index = 0; index < worksheets.length; index += 1) {
        const worksheet = worksheets[index];
        const singlePath = path.join(tempRoot, `sheet-${index + 1}.xlsx`);
        const sheetOutput = path.join(outputDir, `sheet-${String(index + 1).padStart(2, "0")}`);
        await createSingleSheetPackage(xlsxInput, singlePath, worksheet.name);
        const report = await renderWorkbook(singlePath, sheetOutput, {});
        sheetReports.push({ sheet: worksheet.name, ...report });
        allPages.push(...report.pages);
        labels.push(...report.pages.map((_page, pageIndex) => `${worksheet.name} · ${pageIndex + 1}/${report.pages.length}`));
      }
      const finalMontage = montagePath ?? path.join(outputDir, "montage.png");
      await createMontage(allPages, finalMontage, labels);
      return {
        montage: path.resolve(finalMontage),
        pages: allPages,
        pageCount: allPages.length,
        pageStats: sheetReports.flatMap((sheet) => sheet.pageStats.map((page) => ({ ...page, sheet: sheet.sheet }))),
        sheets: sheetReports,
      };
    }
    const sourcePath = path.join(sourceDir, "workbook.xlsx");
    await fs.copyFile(xlsxInput, sourcePath);
    const conversion = await runLibreOffice([
      "--convert-to",
      "pdf:calc_pdf_Export",
      "--outdir",
      pdfDir,
      sourcePath,
    ], profileDir);
    const generatedPdf = path.join(pdfDir, "workbook.pdf");
    if (!(await pathExists(generatedPdf))) {
      throw new Error(`LibreOffice did not produce a PDF. ${conversion.stderr || conversion.stdout}`.trim());
    }

    const finalPdf = pdfPath ?? path.join(outputDir, "workbook.pdf");
    await ensureParent(finalPdf);
    await fs.copyFile(generatedPdf, finalPdf);
    const prefix = path.join(outputDir, "page");
    const rendererName = path.basename(renderer).toLowerCase();
    if (rendererName.startsWith("pdftoppm")) {
      await execFileAsync(renderer, ["-png", "-r", "144", generatedPdf, prefix], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    } else if (rendererName.startsWith("mutool")) {
      await execFileAsync(renderer, ["draw", "-r", "144", "-o", `${prefix}-%d.png`, generatedPdf], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    } else {
      await execFileAsync(renderer, ["-density", "144", generatedPdf, `${prefix}-%d.png`], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    }
    const pageNames = (await fs.readdir(outputDir)).filter((name) => /^page-?\d+\.png$/i.test(name)).sort(naturalPageSort);
    if (pageNames.length === 0) throw new Error("The PDF renderer produced no page images");
    const pages = pageNames.map((name) => path.join(outputDir, name));
    const pageStats = await Promise.all(pages.map(analyzeRenderedPage));
    const finalMontage = montagePath ?? path.join(outputDir, "montage.png");
    await createMontage(pages, finalMontage);
    return {
      pdf: path.resolve(finalPdf),
      montage: path.resolve(finalMontage),
      pages: pages.map((page) => path.resolve(page)),
      pageCount: pages.length,
      pageStats,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function commandRender(options) {
  const inputPath = requireOption(options, "input");
  const outputDir = assertInternalArtifactPath(requireOption(options, "out-dir"), "Spreadsheet render directory");
  if (options.pdf) assertInternalArtifactPath(String(options.pdf), "Spreadsheet render PDF");
  if (options.montage) assertInternalArtifactPath(String(options.montage), "Spreadsheet render montage");
  assertSupportedInput(inputPath, { legacy: true });
  const rendered = await renderWorkbook(inputPath, outputDir, {
    pdfPath: options.pdf ? String(options.pdf) : undefined,
    montagePath: options.montage ? String(options.montage) : undefined,
    perSheet: Boolean(options["per-sheet"]),
  });
  const blankPages = rendered.pageStats.filter((page) => page.blank);
  await emitReport({ status: blankPages.length > 0 ? "partial" : "ok", input: path.resolve(inputPath), blankPages, ...rendered }, options.report && String(options.report));
}

async function fileSha256(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function attestationPathFor(requirementsPath, candidatePath) {
  return requirementsPath
    ? path.join(path.dirname(path.resolve(requirementsPath)), "attestation.json")
    : `${path.resolve(candidatePath)}.attestation.json`;
}

function attestationSourceBindings(requirements) {
  const bindings = [
    ...(requirements?.sourceFiles ?? []).map((item) => ({ path: resolveThroughExistingAncestor(item.path), sha256: item.sha256.toLowerCase() })),
    ...(requirements?.task?.input ? [{ path: resolveThroughExistingAncestor(requirements.task.input.path), sha256: requirements.task.input.sha256.toLowerCase() }] : []),
    ...(requirements?.task?.styleSource ? [{ path: resolveThroughExistingAncestor(requirements.task.styleSource.path), sha256: requirements.task.styleSource.sha256.toLowerCase() }] : []),
  ];
  return [...new Map(bindings.map((item) => [item.path, item])).values()];
}

async function writeSpreadsheetAttestation({ candidatePath, requirementsPath, builderPath, requirements, audit }) {
  const target = assertInternalArtifactPath(attestationPathFor(requirementsPath, candidatePath), "Spreadsheet audit attestation");
  const attestation = validateSpreadsheetAttestation({
    protocol: SPREADSHEET_ATTESTATION_PROTOCOL,
    createdAt: new Date().toISOString(),
    profile: taskValidationProfile(requirements),
    candidate: { path: resolveThroughExistingAncestor(candidatePath), sha256: await fileSha256(candidatePath) },
    requirements: { path: resolveThroughExistingAncestor(requirementsPath), sha256: await fileSha256(requirementsPath) },
    builder: { path: resolveThroughExistingAncestor(builderPath), sha256: await fileSha256(builderPath) },
    runtime: { node: process.version, cliSha256: await fileSha256(fileURLToPath(import.meta.url)) },
    sources: attestationSourceBindings(requirements),
    evidence: requirements?.numericIntegrity?.evidence?.sha256
      ? { path: resolveThroughExistingAncestor(requirements.numericIntegrity.evidence.path), sha256: requirements.numericIntegrity.evidence.sha256.toLowerCase() }
      : null,
    plan: requirements?.numericIntegrity?.plan?.sha256
      ? { path: resolveThroughExistingAncestor(requirements.numericIntegrity.plan.path), sha256: requirements.numericIntegrity.plan.sha256.toLowerCase() }
      : null,
    audit,
  });
  await writeJson(target, attestation);
  return { path: target, sha256: await fileSha256(target), attestation };
}

async function observedBinding(binding) {
  if (!binding?.path || !(await pathExists(binding.path))) return binding?.path ? { path: resolveThroughExistingAncestor(binding.path), sha256: null } : null;
  return { path: resolveThroughExistingAncestor(binding.path), sha256: await fileSha256(binding.path) };
}

async function loadVerifiedSpreadsheetAttestation(attestationPath, candidatePath, requirementsPath, { includeExternal = false } = {}) {
  const resolvedPath = assertInternalArtifactPath(attestationPath, "Spreadsheet audit attestation");
  const attestation = validateSpreadsheetAttestation(await readJsonFile(resolvedPath, "Spreadsheet audit attestation"));
  const actual = {
    candidate: await observedBinding({ path: candidatePath }),
    requirements: await observedBinding({ path: requirementsPath }),
  };
  if (includeExternal) {
    actual.builder = await observedBinding(attestation.builder);
    actual.sources = await Promise.all(attestation.sources.map((binding) => observedBinding(binding)));
    if (attestation.evidence) actual.evidence = await observedBinding(attestation.evidence);
    if (attestation.plan) actual.plan = await observedBinding(attestation.plan);
  }
  const failures = compareAttestationBindings(attestation, actual, { includeExternal });
  if (failures.length > 0) {
    throw blocked("stale-spreadsheet-attestation", "Spreadsheet audit bindings changed after the candidate was validated", {
      attestation: resolvedPath,
      failures,
      next: "Rebuild the candidate once; do not rerun individual audit stages or inspect the CLI implementation.",
    });
  }
  return { path: resolvedPath, sha256: await fileSha256(resolvedPath), attestation };
}

function evaluateRenderRequirements(rendered, requirements) {
  const checks = [];
  if (!requirements) return { status: "not_requested", total: 0, passed: 0, checks: [], failures: [] };
  if (Number.isFinite(requirements.maxTotalPages)) {
    checks.push({ type: "max_total_pages", passed: rendered.pageCount <= requirements.maxTotalPages, expected: requirements.maxTotalPages, actual: rendered.pageCount });
  }
  for (const item of requirements.maxPagesPerSheet ?? []) {
    const actual = rendered.sheets.find((sheet) => sheet.sheet === item.sheet)?.pageCount ?? null;
    checks.push({ type: "max_pages_per_sheet", passed: actual !== null && actual <= item.max, sheet: item.sheet, expected: item.max, actual });
  }
  const failures = checks.filter((check) => !check.passed);
  return { status: failures.length === 0 ? "passed" : "failed", total: checks.length, passed: checks.length - failures.length, checks, failures };
}

async function readJsonFile(filePath, purpose) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${purpose} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${purpose} must be a JSON object`);
  return value;
}

async function decodedPixelDigest(pagePath) {
  const { data, info } = await sharp(pagePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const digest = crypto.createHash("sha256");
  digest.update(`${info.width}x${info.height}x${info.channels}\0`);
  digest.update(data);
  return { sha256: digest.digest("hex"), width: info.width, height: info.height, channels: info.channels };
}

async function assertQaBindings(state, reportPath) {
  if (![VISUAL_REVIEW_PROTOCOL, LEGACY_VISUAL_REVIEW_PROTOCOL].includes(state.protocol)) throw new Error(`Unsupported spreadsheet QA protocol in ${reportPath}`);
  if (!state.candidate?.path || !state.requirements?.path) throw new Error("Spreadsheet QA report is missing candidate or requirements binding");
  const candidateSha256 = await fileSha256(state.candidate.path);
  const requirementsSha256 = await fileSha256(state.requirements.path);
  if (candidateSha256 !== state.candidate.sha256) {
    throw blocked("stale-spreadsheet-qa", "The spreadsheet candidate changed after QA initialization", { expected: state.candidate.sha256, actual: candidateSha256 });
  }
  if (requirementsSha256 !== state.requirements.sha256) {
    throw blocked("stale-spreadsheet-requirements", "The spreadsheet requirements changed after QA initialization", { expected: state.requirements.sha256, actual: requirementsSha256 });
  }
  if (state.protocol === VISUAL_REVIEW_PROTOCOL) {
    if (!state.attestation?.path || !state.attestation?.sha256) throw new Error("Spreadsheet QA report is missing its audit attestation binding");
    const actualAttestationSha256 = await fileSha256(state.attestation.path);
    if (actualAttestationSha256 !== state.attestation.sha256) {
      throw blocked("stale-spreadsheet-attestation", "The spreadsheet audit attestation changed after QA initialization", {
        expected: state.attestation.sha256,
        actual: actualAttestationSha256,
      });
    }
  }
  for (const page of state.pages ?? []) {
    const digest = await decodedPixelDigest(page.path);
    if (digest.sha256 !== page.pixelSha256) {
      throw blocked("stale-spreadsheet-render", "A spreadsheet render page changed after QA initialization", { page: page.id, expected: page.pixelSha256, actual: digest.sha256 });
    }
  }
}

async function visualReviewSignals(inputPath, requirements, audit) {
  const workbook = await loadXlsx(inputPath);
  const chartSheets = new Set((audit?.package?.charts ?? []).map((chart) => chart.sheet).filter(Boolean));
  const requiredSheets = new Set(requirements?.requiredSheets ?? []);
  return workbook.worksheets.map((worksheet) => {
    let formulaCount = 0;
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (formulaDescriptor(cell)) formulaCount += 1;
      });
    });
    return {
      name: worksheet.name,
      rowCount: Math.max(worksheet.rowCount, worksheet.actualRowCount),
      formulaCount,
      hasChart: chartSheets.has(worksheet.name),
      required: requiredSheets.has(worksheet.name),
    };
  });
}

async function commandQaInit(options) {
  const inputPath = assertInternalArtifactPath(requireOption(options, "input"), "Spreadsheet candidate");
  const requirementsPath = assertInternalArtifactPath(requireOption(options, "requirements"), "Spreadsheet requirements");
  const reportPath = assertInternalArtifactPath(requireOption(options, "report"), "Spreadsheet visual review report");
  const renderDir = assertInternalArtifactPath(
    options["render-dir"] ? requireOption(options, "render-dir") : path.join(path.dirname(reportPath), "render"),
    "Spreadsheet visual review render",
  );
  if (await pathExists(reportPath) && !options.overwrite) {
    throw blocked("qa-report-exists", "The spreadsheet visual review report already exists", { report: reportPath, next: "Reuse it or pass --overwrite after rebuilding the candidate." });
  }
  if (options.overwrite) await fs.rm(renderDir, { recursive: true, force: true });
  const requirements = await runStage("requirements_validation", () => resolveRequirements(requirementsPath));
  if (!requirements?.task) throw blocked("unprepared-spreadsheet-task", "QA requires requirements produced by prepare");
  const isV2 = requirements.task.protocol === TASK_PROTOCOL;
  const attestationPath = options.attestation
    ? assertInternalArtifactPath(requireOption(options, "attestation"), "Spreadsheet audit attestation")
    : attestationPathFor(requirementsPath, inputPath);
  const verifiedAttestation = isV2
    ? await runStage("attestation", () => loadVerifiedSpreadsheetAttestation(attestationPath, inputPath, requirementsPath))
    : null;
  const audit = verifiedAttestation?.attestation.audit ?? await runStage("audit", () => auditXlsx(inputPath, requirements));
  if (audit.status === "error") throw new Error(`Candidate workbook failed QA audit. ${summarizeAuditFailures(audit)}`);
  if (audit.coverage.status !== "passed" || audit.coverage.total === 0) throw new Error("Candidate workbook has no passing, verifiable requirement coverage");
  if (audit.warningDispositions.status === "failed") {
    const unresolved = audit.warningDispositions.unresolved.map((warning) => ({
      type: warning.type,
      count: warning.cells?.length ?? warning.sheets?.length ?? 1,
      samples: (warning.cells ?? warning.sheets ?? []).slice(0, 10),
    }));
    throw blocked("spreadsheet-audit-warnings", "Candidate workbook has unresolved audit warnings", {
      warnings: unresolved,
      next: unresolved.some((warning) => warning.type === "cjk_font_fallback")
        ? "Rebuild the candidate so the post-build CJK typography normalization can replace Latin-only fallback fonts; do not suppress this warning for a net-new workbook."
        : "Fix the reported workbook issue or declare a task-specific warningDispositions rationale, then rebuild and restart QA.",
    });
  }

  const visualPolicy = requirements.task.visualReview;
  let rendered = null;
  let renderCoverage = { status: "not_required", total: 0, passed: 0, checks: [], failures: [] };
  let pages = [];
  if (visualPolicy.mode !== "structural-only") {
    const signals = await visualReviewSignals(inputPath, requirements, audit);
    const mustRenderAllSheets = visualPolicy.mode === "all-pages"
      || requirements.maxTotalPages !== undefined
      || (requirements.maxPagesPerSheet?.length ?? 0) > 0;
    const adaptiveSheets = visualPolicy.mode === "adaptive" && !mustRenderAllSheets
      ? selectAdaptiveSheets(signals)
      : null;
    rendered = await runStage("render", () => renderWorkbook(inputPath, renderDir, {
      perSheet: true,
      montagePath: path.join(renderDir, "montage.png"),
      sheetNames: visualPolicy.mode === "selected-sheets" ? visualPolicy.sheets : adaptiveSheets,
    }));
    const blankPages = rendered.pageStats.filter((page) => page.blank);
    if (blankPages.length > 0) throw new Error(`Candidate workbook produced blank print page(s): ${blankPages.map((page) => `${page.sheet}:${path.basename(page.path)}`).join(", ")}`);
    renderCoverage = evaluateRenderRequirements(rendered, requirements);
    if (renderCoverage.status === "failed") throw new Error(`Candidate workbook failed render requirements: ${renderCoverage.failures.map((failure) => failure.type).join(", ")}`);
    const pageNumberBySheet = new Map();
    const numberedPages = rendered.pageStats.map((page) => {
      const pageNumber = (pageNumberBySheet.get(page.sheet) ?? 0) + 1;
      pageNumberBySheet.set(page.sheet, pageNumber);
      return { ...page, page: pageNumber };
    });
    for (const page of selectReviewPages(numberedPages, requirements.task)) {
      const pixels = await decodedPixelDigest(page.path);
      pages.push({
        id: `${page.sheet}#${page.page}`,
        sheet: page.sheet,
        page: page.page,
        path: page.path,
        pixelSha256: pixels.sha256,
        width: pixels.width,
        height: pixels.height,
        review: null,
      });
    }
  }
  const state = {
    status: "partial",
    protocol: VISUAL_REVIEW_PROTOCOL,
    candidate: { path: path.resolve(inputPath), sha256: await fileSha256(inputPath) },
    requirements: { path: path.resolve(requirementsPath), sha256: await fileSha256(requirementsPath) },
    ...(verifiedAttestation ? { attestation: { path: verifiedAttestation.path, sha256: verifiedAttestation.sha256 } } : {}),
    task: requirements.task,
    audit,
    renderCoverage,
    render: rendered,
    pages,
    visualReview: { status: pages.length > 0 ? "pending" : "not_required", reviewed: 0, total: pages.length },
  };
  await writeJson(reportPath, state);
  if (!options.quiet) await emitReport({ ...state, report: reportPath });
}

async function commandQaRecord(options) {
  const reportPath = assertInternalArtifactPath(requireOption(options, "report"), "Spreadsheet visual review report");
  const state = await readJsonFile(reportPath, "Spreadsheet visual review report");
  await assertQaBindings(state, reportPath);
  const sheet = requireOption(options, "sheet");
  const pageNumber = integerOption(options, "page", null);
  const status = requireOption(options, "status");
  const notes = requireOption(options, "notes").trim();
  if (!notes) throw new Error("--notes must describe what was inspected on this page");
  if (!["passed", "failed"].includes(status)) throw new Error("--status must be passed or failed");
  const page = state.pages?.find((item) => item.sheet === sheet && item.page === pageNumber);
  if (!page) throw new Error(`Visual review page not found: ${sheet}#${pageNumber}`);
  page.review = { status, notes };
  const reviewed = state.pages.filter((item) => item.review).length;
  state.status = "partial";
  state.visualReview = { status: "pending", reviewed, total: state.pages.length };
  await writeJson(reportPath, state);
  if (!options.quiet) await emitReport({ status: "ok", report: reportPath, page: page.id, review: page.review, progress: state.visualReview });
}

async function commandQaComplete(options) {
  const reportPath = assertInternalArtifactPath(requireOption(options, "report"), "Spreadsheet visual review report");
  const reviewsPath = assertInternalArtifactPath(requireOption(options, "reviews"), "Spreadsheet visual review observations");
  const state = await readJsonFile(reportPath, "Spreadsheet visual review report");
  await assertQaBindings(state, reportPath);
  const payload = await readJsonFile(reviewsPath, "Spreadsheet visual review observations");
  const reviews = payload.reviews;
  if (!Array.isArray(reviews)) throw new Error("Spreadsheet visual review observations must contain a reviews array");
  const seen = new Set();
  for (const [index, review] of reviews.entries()) {
    if (!review || typeof review !== "object" || Array.isArray(review)) throw new Error(`reviews[${index}] must be an object`);
    const sheet = String(review.sheet ?? "");
    const pageNumber = Number(review.page);
    const status = String(review.status ?? "");
    const notes = String(review.notes ?? "").trim();
    if (!sheet || !Number.isInteger(pageNumber) || pageNumber < 1) throw new Error(`reviews[${index}] requires sheet and positive page`);
    if (!['passed', 'failed'].includes(status)) throw new Error(`reviews[${index}].status must be passed or failed`);
    if (!notes) throw new Error(`reviews[${index}].notes must be non-empty`);
    const page = state.pages?.find((item) => item.sheet === sheet && item.page === pageNumber);
    if (!page) throw new Error(`Visual review page not found: ${sheet}#${pageNumber}`);
    if (seen.has(page.id)) throw new Error(`Visual review page is duplicated: ${page.id}`);
    seen.add(page.id);
    page.review = { status, notes };
  }
  const missing = (state.pages ?? []).filter((page) => !seen.has(page.id));
  if (missing.length > 0) {
    throw blocked("incomplete-spreadsheet-visual-observations", "The batch review does not cover every selected page", {
      pages: missing.map((page) => page.id),
    });
  }
  state.status = "partial";
  state.visualReview = { status: "pending", reviewed: seen.size, total: state.pages.length };
  await writeJson(reportPath, state);
  await commandQaFinalize({ report: reportPath, quiet: true });
  const finalized = await readJsonFile(reportPath, "Spreadsheet visual review report");
  if (!options.quiet) await emitReport({
    status: finalized.status,
    report: reportPath,
    visualReview: finalized.visualReview,
    next: "Deliver the unchanged candidate; delivery will verify the attestation and copy hash without rerunning the audit.",
  });
}

async function commandQaFinalize(options) {
  const reportPath = assertInternalArtifactPath(requireOption(options, "report"), "Spreadsheet visual review report");
  const state = await readJsonFile(reportPath, "Spreadsheet visual review report");
  await assertQaBindings(state, reportPath);
  const missing = (state.pages ?? []).filter((page) => !page.review || !String(page.review.notes ?? "").trim());
  const failed = (state.pages ?? []).filter((page) => page.review?.status !== "passed");
  if (missing.length > 0) throw blocked("incomplete-spreadsheet-visual-review", "Every rendered spreadsheet page requires a review record", { pages: missing.map((page) => page.id) });
  if (failed.length > 0) throw blocked("failed-spreadsheet-visual-review", "Spreadsheet visual review contains failed pages", { pages: failed.map((page) => page.id) });
  const requirements = await resolveRequirements(state.requirements.path);
  const audit = state.protocol === VISUAL_REVIEW_PROTOCOL
    ? (await loadVerifiedSpreadsheetAttestation(state.attestation.path, state.candidate.path, state.requirements.path)).attestation.audit
    : await auditXlsx(state.candidate.path, requirements);
  if (audit.status === "error" || audit.coverage.status !== "passed" || audit.warningDispositions.status === "failed") {
    throw new Error(`Candidate workbook no longer passes final QA. ${summarizeAuditFailures(audit)}`);
  }
  state.status = "ok";
  state.audit = audit;
  state.visualReview = {
    status: (state.pages ?? []).length > 0 ? "passed" : "not_required",
    reviewed: (state.pages ?? []).length,
    total: (state.pages ?? []).length,
  };
  await writeJson(reportPath, state);
  if (!options.quiet) await emitReport({ ...state, report: reportPath });
}

async function commandDeliver(options) {
  const inputPath = requireOption(options, "input");
  assertInternalArtifactPath(inputPath, "Spreadsheet candidate");
  const outputPath = assertDeliveryOutputPath(requireOption(options, "out"));
  const requirementsPath = assertInternalArtifactPath(
    requireOption(options, "requirements"),
    "Spreadsheet requirements",
  );
  const qaReportPath = assertInternalArtifactPath(requireOption(options, "qa-report"), "Spreadsheet visual review report");
  if (workbookExtension(inputPath) !== ".xlsx" || workbookExtension(outputPath) !== ".xlsx") {
    throw new Error("deliver currently seals .xlsx candidates only");
  }
  if (pathsReferToSameLocation(inputPath, outputPath)) throw new Error("Deliverable must be distinct from the candidate workbook");
  if (await pathExists(outputPath)) throw new Error(`Refusing to overwrite existing deliverable: ${outputPath}`);
  const requirements = await runStage("requirements_validation", () => resolveRequirements(requirementsPath));
  if (!requirements?.task) throw blocked("unprepared-spreadsheet-task", "Delivery requires requirements produced by prepare");
  if (!pathsReferToSameLocation(outputPath, requirements.task.finalOutput)) {
    throw blocked("unprepared-delivery-output", "The delivery output does not match the path frozen by prepare", { prepared: requirements.task.finalOutput, actual: outputPath });
  }
  const qaState = await readJsonFile(qaReportPath, "Spreadsheet visual review report");
  await assertQaBindings(qaState, qaReportPath);
  if (qaState.status !== "ok" || !["passed", "not_required"].includes(qaState.visualReview?.status)) {
    throw blocked("spreadsheet-qa-not-finalized", "Spreadsheet QA must be finalized before delivery", { status: qaState.status, visualReview: qaState.visualReview?.status });
  }
  if (!pathsReferToSameLocation(inputPath, qaState.candidate.path) || !pathsReferToSameLocation(requirementsPath, qaState.requirements.path)) {
    throw blocked("spreadsheet-qa-binding-mismatch", "Delivery input or requirements do not match the finalized QA report");
  }
  const verifiedAttestation = requirements.task.protocol === TASK_PROTOCOL
    ? await runStage("attestation", () => loadVerifiedSpreadsheetAttestation(
      qaState.attestation.path,
      inputPath,
      requirementsPath,
      { includeExternal: true },
    ))
    : null;
  const audit = verifiedAttestation?.attestation.audit ?? await runStage("audit", () => auditXlsx(inputPath, requirements));
  if (audit.status === "error") throw new Error(`Candidate workbook failed structural, formula, or requirement coverage audit. ${summarizeAuditFailures(audit)}`);
  if (audit.coverage.status !== "passed" || audit.coverage.total === 0) {
    throw new Error("Candidate workbook has no passing, verifiable requirement coverage");
  }
  if (audit.warningDispositions.status === "failed") {
    throw new Error(`Candidate workbook has unresolved audit warnings: ${audit.warningDispositions.unresolved.map((warning) => warning.type).join(", ")}`);
  }
  const projectWorkspace = await runStage("project_workspace", () => assertProjectWorkspaceClean(requirements));

  await ensureParent(outputPath);
  const temporaryOutput = path.join(path.dirname(path.resolve(outputPath)), `.${path.basename(outputPath)}.${process.pid}.tmp`);
  await fs.copyFile(inputPath, temporaryOutput);
  const candidateSha256 = await fileSha256(inputPath);
  const copiedSha256 = await fileSha256(temporaryOutput);
  if (candidateSha256 !== copiedSha256) {
    await fs.rm(temporaryOutput, { force: true });
    throw new Error("Candidate and sealed deliverable hashes do not match");
  }
  await fs.rename(temporaryOutput, outputPath);
  const finalSha256 = await fileSha256(outputPath);
  const finalAudit = verifiedAttestation ? audit : await auditXlsx(outputPath, requirements);
  if (finalAudit.status === "error" || finalAudit.coverage.status !== "passed" || finalAudit.warningDispositions.status === "failed" || finalSha256 !== candidateSha256) {
    await fs.rm(outputPath, { force: true });
    throw new Error("Final deliverable failed post-seal verification");
  }
  const lineage = await recordSpreadsheetDelivery(outputPath, requirements.task.input ?? null, finalSha256);
  const report = {
    status: finalAudit.status,
    output: path.resolve(outputPath),
    sha256: finalSha256,
    coverage: finalAudit.coverage,
    qa: { report: qaReportPath, protocol: qaState.protocol, visualReview: qaState.visualReview },
    attestation: verifiedAttestation ? { path: verifiedAttestation.path, sha256: verifiedAttestation.sha256 } : null,
    renderCoverage: qaState.renderCoverage,
    audit: finalAudit,
    render: qaState.render,
    blankPages: [],
    projectWorkspace,
    lineage,
  };
  if (!options.quiet) await emitReport(report, options.report && String(options.report));
  else if (options.report) await writeJson(String(options.report), report);
}

async function createSelfTestWorkbook() {
  const workbook = createWorkbook();
  const inputs = workbook.addWorksheet("输入数据", { views: [{ showGridLines: false }] });
  inputs.addRows([
    ["假设 / Assumption", "数值 / Value"],
    ["收入", 100000],
    ["增长率", 0.1],
  ]);
  styleHeader(inputs, "A1:B1");
  inputs.getCell("B2").numFmt = '"$"#,##0';
  inputs.getCell("B3").numFmt = "0.0%";
  autoFitColumns(inputs, { min: 12, max: 24 });

  const summary = workbook.addWorksheet("汇总", {
    views: [{ state: "frozen", ySplit: 3, showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  summary.mergeCells("A1:D1");
  summary.getCell("A1").value = "PilotDeck 表格能力自测";
  summary.getCell("A1").font = { size: 18, bold: true, color: { argb: "FF0F172A" } };
  summary.getRow(1).height = 28;
  summary.addRows([
    [],
    ["月份", "收入", "成本"],
    ["1月", 100000, 70000],
    ["2月", 120000, 78000],
    ["3月", 135000, 85000],
  ]);
  addTableFromRange(summary, { name: "SelfTestTable", range: "A3:C6" });
  summary.getCell("D3").value = "利润率";
  styleHeader(summary, "D3:D3");
  for (let row = 4; row <= 6; row += 1) {
    summary.getCell(`D${row}`).value = { formula: `IFERROR((B${row}-C${row})/B${row},0)`, result: 0 };
    summary.getCell(`D${row}`).numFmt = "0.0%";
  }
  summary.getCell("A8").value = "预计收入";
  summary.getCell("B8").value = { formula: "'输入数据'!B2*(1+'输入数据'!B3)", result: 0 };
  summary.getCell("B8").numFmt = '"$"#,##0';
  summary.getCell("F3").value = "状态";
  summary.getCell("F4").value = "正常";
  addListValidation(summary, "F4:F6", ["正常", "风险", "阻塞"], { allowBlank: false });
  addConditionalFormatting(summary, {
    range: "D4:D6",
    rules: [{ type: "cellIs", operator: "lessThan", formulae: [0.25], style: { font: { color: { argb: "FFB91C1C" } } } }],
  });
  setNumberFormat(summary, "B4:C6", '"$"#,##0');
  autoFitColumns(summary, { min: 11, max: 26 });
  applyChineseTypography(inputs, { platform: "cross-platform" });
  applyChineseTypography(summary, { platform: "cross-platform", titleRanges: ["A1:D1"] });

  const types = workbook.addWorksheet("类型回归", {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
  });
  types.addRows([
    ["行动项编号", "完成率", "截止日期", "状态"],
    ["A-001", 0.5, new Date("2026-04-30T00:00:00Z"), "进行中"],
    ["A-002", 0.8, new Date("2026-05-31T00:00:00Z"), "已完成"],
  ]);
  applyStyle(types, "A1:D3", { alignment: { vertical: "middle" } });
  styleHeader(types, "A1:D1");
  setNumberFormat(types, "B2:B3", "0.0%");
  setNumberFormat(types, "C2:C3", "yyyy-mm-dd");
  addTableFromRange(types, { name: "TypeRegressionTable", range: "A1:D3" });
  addListValidation(types, "D2:D3", ["未开始", "进行中", "已完成"], { allowBlank: false });
  addConditionalFormatting(types, {
    range: "B2:B3",
    rules: [{ type: "cellIs", operator: "lessThan", formulae: [0.6], style: { font: { color: { argb: "FFB91C1C" } } } }],
  });
  autoFitColumns(types, { min: 12, max: 24 });
  applyChineseTypography(types, { platform: "cross-platform" });
  NATIVE_CHART_SPECS.set(workbook, [{
    sheet: "汇总",
    type: "line",
    title: "收入与成本趋势",
    minPoints: 3,
    categories: "A4:A6",
    series: [{ name: "收入", values: "B4:B6" }, { name: "成本", values: "C4:C6" }],
    anchor: { from: "A10", to: "H25" },
    valueFormat: "¥#,##0",
  }]);
  return workbook;
}

async function commandSelfTest(options) {
  const outputDir = options.out ? String(options.out) : path.join(os.tmpdir(), `pilotdeck-spreadsheets-self-test-${Date.now()}`);
  await fs.mkdir(outputDir, { recursive: true });
  const steps = [];

  const rawPath = path.join(outputDir, "raw.xlsx");
  const finalPath = path.join(outputDir, "self-test.xlsx");
  const configuredWorkDir = pilotDeckWorkDir();
  const sealedPath = configuredWorkDir && isInsidePath(resolveThroughExistingAncestor(outputDir), configuredWorkDir)
    ? path.join(await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-self-test-delivery-")), "sealed.xlsx")
    : path.join(outputDir, "sealed.xlsx");
  const workbook = await createSelfTestWorkbook();
  const nativeCharts = NATIVE_CHART_SPECS.get(workbook) ?? [];
  await workbook.xlsx.writeFile(rawPath);
  steps.push({ name: "create", status: "ok", output: rawPath });

  const workDirBeforePrepare = process.env.PILOTDECK_WORK_DIR;
  const preparedWorkDir = path.join(outputDir, "prepared-turn");
  process.env.PILOTDECK_WORK_DIR = preparedWorkDir;
  let preparedReport;
  try {
    preparedReport = await commandPrepare({
      "final-out": path.join(outputDir, "prepared-final.xlsx"),
      "workbook-type": "data",
      quiet: true,
    });
  } finally {
    if (workDirBeforePrepare === undefined) delete process.env.PILOTDECK_WORK_DIR;
    else process.env.PILOTDECK_WORK_DIR = workDirBeforePrepare;
  }
  const preparedRequirements = await readJsonFile(preparedReport.paths.requirements, "Self-test prepared requirements");
  if (preparedRequirements.task.styleMode !== "neutral-built-in" || preparedRequirements.task.allowDecorativeTitle !== false) {
    throw new Error("Spreadsheet prepare did not freeze the neutral built-in policy");
  }
  if (preparedRequirements.task.protocol !== TASK_PROTOCOL
    || preparedRequirements.task.validationProfile !== "fast"
    || preparedRequirements.task.dataOperation !== "create"
    || preparedRequirements.task.projectSnapshot?.protocol !== PROJECT_GUARD_PROTOCOL) {
    throw new Error("Spreadsheet prepare did not freeze the v2 task profile and scoped project guard");
  }
  steps.push({ name: "prepare-protocol", status: "ok", styleMode: preparedRequirements.task.styleMode });

  const standardCopyProfile = deriveTaskProfile({ dataOperation: "copy", sourceCount: 1 });
  const strictTransformProfile = deriveTaskProfile({ dataOperation: "transform", sourceCount: 2 });
  let profileDowngradeRejected = false;
  try {
    deriveTaskProfile({ requestedProfile: "fast", dataOperation: "union", sourceCount: 2 });
  } catch (error) {
    profileDowngradeRejected = error instanceof Error && error.message.includes("below the 'standard' minimum");
  }
  if (standardCopyProfile.profile !== "standard" || strictTransformProfile.profile !== "strict" || !profileDowngradeRejected) {
    throw new Error("Spreadsheet validation profiles did not enforce operation-based minimums");
  }
  steps.push({
    name: "validation-profiles",
    status: "ok",
    create: preparedRequirements.task.validationProfile,
    copy: standardCopyProfile.profile,
    transform: strictTransformProfile.profile,
    downgradeRejected: true,
  });

  const cjkOrderWorkbook = createWorkbook();
  const cjkOrderSheet = cjkOrderWorkbook.addWorksheet("中文后处理");
  cjkOrderSheet.getCell("A1").value = "构建完成后新增的中文标题";
  cjkOrderSheet.getCell("A1").font = { name: "Arial", size: 17, bold: true, color: { argb: "FF123456" } };
  const cjkNormalization = normalizeCjkTypography(cjkOrderWorkbook, {
    task: { styleMode: "neutral-built-in" },
  });
  const normalizedCjkFont = cjkOrderSheet.getCell("A1").font;
  if (cjkNormalization.cells !== 1 || LATIN_ONLY_CJK_FONTS.has(normalizedCjkFont.name.toLowerCase())
    || normalizedCjkFont.size !== 17 || normalizedCjkFont.bold !== true || normalizedCjkFont.color?.argb !== "FF123456") {
    throw new Error("Post-build CJK typography normalization did not preserve non-font style attributes");
  }
  steps.push({ name: "post-build-cjk-typography", status: "ok", font: normalizedCjkFont.name });

  const snapshotProjectRoot = path.join(outputDir, "project-snapshot-fixture");
  await fs.mkdir(snapshotProjectRoot, { recursive: true });
  await fs.writeFile(path.join(snapshotProjectRoot, "source.txt"), "frozen\n", "utf8");
  const snapshotBefore = await captureProjectSnapshot(snapshotProjectRoot, {
    finalOutput: path.join(snapshotProjectRoot, "final.xlsx"),
    workDir: path.join(snapshotProjectRoot, ".pilotdeck", "work"),
  });
  await fs.mkdir(path.join(snapshotProjectRoot, ".pilotdeck", "work"), { recursive: true });
  await fs.writeFile(path.join(snapshotProjectRoot, ".pilotdeck", "work", "allowed-debug.json"), "{}\n", "utf8");
  const snapshotWorkDir = path.join(snapshotProjectRoot, ".pilotdeck", "work");
  const snapshotManifestPath = path.join(snapshotWorkDir, "spreadsheets", "qa", "project-snapshot.json");
  const snapshotPreviousWorkDir = process.env.PILOTDECK_WORK_DIR;
  process.env.PILOTDECK_WORK_DIR = snapshotWorkDir;
  await writeJson(snapshotManifestPath, snapshotBefore);
  await fs.writeFile(path.join(snapshotProjectRoot, "build_q1.mjs"), "export default {};\n", "utf8");
  let projectDirtyRejected = false;
  try {
    await assertProjectWorkspaceClean({
      task: {
        finalOutput: path.join(snapshotProjectRoot, "final.xlsx"),
        projectSnapshot: {
          protocol: PROJECT_SNAPSHOT_PROTOCOL,
          path: snapshotManifestPath,
          sha256: await fileSha256(snapshotManifestPath),
        },
      },
    });
  } catch (error) {
    projectDirtyRejected = error instanceof SpreadsheetProtocolError && error.code === "spreadsheet-project-dirty";
  } finally {
    if (snapshotPreviousWorkDir === undefined) delete process.env.PILOTDECK_WORK_DIR;
    else process.env.PILOTDECK_WORK_DIR = snapshotPreviousWorkDir;
  }
  const snapshotAfter = await captureProjectSnapshot(snapshotProjectRoot, {
    finalOutput: path.join(snapshotProjectRoot, "final.xlsx"),
    workDir: path.join(snapshotProjectRoot, ".pilotdeck", "work"),
  });
  const snapshotDiff = compareProjectSnapshots(snapshotBefore, snapshotAfter);
  if (!projectDirtyRejected || snapshotDiff.clean || snapshotDiff.created.map((item) => item.path).join(",") !== "build_q1.mjs") {
    throw new Error("Project snapshot did not isolate internal work files from project-root pollution");
  }
  steps.push({ name: "project-workspace-pollution-gate", status: "ok", created: snapshotDiff.created.map((item) => item.path) });

  const guardProjectRoot = path.join(outputDir, "project-guard-v2-fixture");
  const guardWorkDir = path.join(guardProjectRoot, ".pilotdeck", "work");
  await fs.mkdir(guardProjectRoot, { recursive: true });
  await fs.writeFile(path.join(guardProjectRoot, "source.txt"), "before\n", "utf8");
  const guardBefore = await captureProjectGuardSnapshot(guardProjectRoot, {
    finalOutput: path.join(guardProjectRoot, "final.xlsx"),
    workDir: guardWorkDir,
  });
  const guardManifestPath = path.join(guardWorkDir, "spreadsheets", "qa", "project-snapshot.json");
  const guardPreviousWorkDir = process.env.PILOTDECK_WORK_DIR;
  process.env.PILOTDECK_WORK_DIR = guardWorkDir;
  await writeJson(guardManifestPath, guardBefore);
  const guardRequirements = {
    task: {
      finalOutput: path.join(guardProjectRoot, "final.xlsx"),
      projectSnapshot: {
        protocol: PROJECT_GUARD_PROTOCOL,
        path: guardManifestPath,
        sha256: await fileSha256(guardManifestPath),
      },
    },
  };
  await fs.writeFile(path.join(guardProjectRoot, "source.txt"), "changed by collaborator\n", "utf8");
  await fs.writeFile(path.join(guardProjectRoot, "notes.txt"), "unrelated\n", "utf8");
  await fs.mkdir(path.join(guardProjectRoot, "qa"), { recursive: true });
  await fs.mkdir(path.join(guardProjectRoot, "render"), { recursive: true });
  await fs.writeFile(path.join(guardProjectRoot, "qa", "team-notes.txt"), "unrelated\n", "utf8");
  await fs.writeFile(path.join(guardProjectRoot, "render", "README.md"), "unrelated\n", "utf8");
  const unrelatedGuardResult = await assertProjectWorkspaceClean(guardRequirements);
  await fs.writeFile(path.join(guardProjectRoot, "build_q2.mjs"), "export default {};\n", "utf8");
  let leakedArtifactRejected = false;
  try {
    await assertProjectWorkspaceClean(guardRequirements);
  } catch (error) {
    leakedArtifactRejected = error instanceof SpreadsheetProtocolError && error.code === "spreadsheet-project-artifacts";
  } finally {
    if (guardPreviousWorkDir === undefined) delete process.env.PILOTDECK_WORK_DIR;
    else process.env.PILOTDECK_WORK_DIR = guardPreviousWorkDir;
  }
  if (unrelatedGuardResult.status !== "passed" || !leakedArtifactRejected) {
    throw new Error("Scoped project guard did not ignore unrelated edits while rejecting leaked spreadsheet artifacts");
  }
  steps.push({ name: "scoped-project-guard-v2", status: "ok", unrelatedEditsIgnored: true, leakedArtifactRejected: true });

  const fallbackFixtureDir = path.join(outputDir, "source-normalization-fixture");
  await fs.mkdir(fallbackFixtureDir, { recursive: true });
  const fallbackHealthyPath = path.join(fallbackFixtureDir, "healthy.xlsx");
  const fallbackMalformedPath = path.join(fallbackFixtureDir, "source.xlsx");
  const fallbackWorkbook = createWorkbook();
  fallbackWorkbook.addWorksheet("订单").addRows([["编号", "金额"], ["A-1", 10.25]]);
  await fallbackWorkbook.xlsx.writeFile(fallbackHealthyPath);
  await fs.copyFile(fallbackHealthyPath, fallbackMalformedPath);
  const fallbackEvidence = await captureSourceEvidence([fallbackMalformedPath], {
    normalizedRoot: path.join(fallbackFixtureDir, "internal-normalized"),
    forceNormalize: true,
  });
  const fallbackSource = fallbackEvidence.sources[0];
  if (fallbackSource.normalization?.engine !== "LibreOffice"
    || pathsReferToSameLocation(fallbackSource.path, fallbackSource.origin.path)
    || fallbackSource.sha256 !== fallbackSource.normalization.derivedSha256
    || fallbackSource.origin.sha256 !== await fileSha256(fallbackMalformedPath)) {
    throw new Error("Unreadable XLSX fallback did not preserve origin-to-derived lineage");
  }
  const originalMalformedBytes = await fs.readFile(fallbackMalformedPath);
  await fs.appendFile(fallbackMalformedPath, Buffer.from("changed"));
  const originChecks = await evaluateSourceFiles({
    sourceBacked: true,
    sourceFiles: [{ path: fallbackSource.path, sha256: fallbackSource.sha256, origin: fallbackSource.origin }],
  });
  await fs.writeFile(fallbackMalformedPath, originalMalformedBytes);
  if (!originChecks.some((check) => check.type === "source_origin_integrity" && check.passed === false)) {
    throw new Error("Source audit did not detect a changed original after normalization");
  }
  steps.push({ name: "source-normalization-lineage", status: "ok", origin: fallbackSource.origin.path, effective: fallbackSource.path });

  const integrityPhase1Dir = path.join(outputDir, "numeric-integrity-phase1");
  const integrityPhase1WorkDir = path.join(integrityPhase1Dir, "turn-work");
  await fs.mkdir(integrityPhase1Dir, { recursive: true });
  const sourceAPath = path.join(integrityPhase1Dir, "source-a.xlsx");
  const sourceBPath = path.join(integrityPhase1Dir, "source-b.xlsx");
  const lookupPath = path.join(integrityPhase1Dir, "lookup.xlsx");
  const calculationSourcePath = path.join(integrityPhase1Dir, "calculation-source.xlsx");
  const imageSourcePath = path.join(integrityPhase1Dir, "amount-scan.png");
  const sourceAWorkbook = createWorkbook();
  sourceAWorkbook.addWorksheet("数据").addRows([["编号", "金额"], ["A-1", 10.25], ["A-2", 20.5]]);
  await sourceAWorkbook.xlsx.writeFile(sourceAPath);
  const sourceBWorkbook = createWorkbook();
  sourceBWorkbook.addWorksheet("数据").addRows([["编号", "金额"], ["B-1", 30.75]]);
  await sourceBWorkbook.xlsx.writeFile(sourceBPath);
  const lookupWorkbook = createWorkbook();
  lookupWorkbook.addWorksheet("分类").addRows([["编号", "分类"], ["A-1", "甲"], ["A-2", "乙"], ["B-1", "丙"]]);
  await lookupWorkbook.xlsx.writeFile(lookupPath);
  const calculationSourceWorkbook = createWorkbook();
  calculationSourceWorkbook.addWorksheet("计算数据").addRows([
    ["编号", "部门", "数量", "单价", "未税金额", "税额"],
    ["X-1", "甲", 3, 10.25, 30.75, 3.08],
    ["X-2", "甲", 2, 5.5, 11, 1.1],
    ["X-3", "乙", 1, 7.25, 7.25, 0.73],
  ]);
  await calculationSourceWorkbook.xlsx.writeFile(calculationSourcePath);
  await sharp({ create: { width: 240, height: 120, channels: 3, background: "white" } })
    .png()
    .toFile(imageSourcePath);

  const autoBindWorkDir = path.join(integrityPhase1Dir, "auto-bind-turn");
  const autoBindPreviousWorkDir = process.env.PILOTDECK_WORK_DIR;
  process.env.PILOTDECK_WORK_DIR = autoBindWorkDir;
  try {
    const autoPrepared = await commandPrepare({
      "final-out": path.join(integrityPhase1Dir, "auto-bound-final.xlsx"),
      source: [sourceAPath],
      "data-operation": "copy",
      quiet: true,
    });
    const autoRequirements = await readJsonFile(autoPrepared.paths.requirements, "Auto-bind requirements");
    const effectiveSourcePath = autoRequirements.sourceFiles[0].path;
    const autoPlan = {
      protocol: NUMERIC_INTEGRITY_PROTOCOL,
      mode: "strict",
      draft: false,
      operations: [{
        id: "copy-source",
        type: "copy",
        fields: {
          id: { semanticType: "identifier" },
          amount: { semanticType: "decimal", scale: 2, currency: "CNY" },
        },
        inputs: [{ source: effectiveSourcePath, sheet: "数据", range: "A2:B3", columns: { id: "A", amount: "B" } }],
        output: { sheet: "复制", range: "A2:B3", columns: { id: "A", amount: "B" } },
        keyColumns: ["id"],
      }],
      invariants: [],
    };
    const autoBuilderSource = `export default async function build({ createWorkbook, helpers }) {\n  const workbook = createWorkbook();\n  workbook.addWorksheet("复制").addRows([["编号", "金额"], ["A-1", 10.25], ["A-2", 20.5]]);\n  helpers.integrity.register(workbook, ${JSON.stringify(autoPlan, null, 2)});\n  return workbook;\n}\n`;
    await fs.writeFile(autoPrepared.paths.builder, autoBuilderSource, "utf8");
    await commandBuild({
      builder: autoPrepared.paths.builder,
      requirements: autoPrepared.paths.requirements,
      out: autoPrepared.paths.candidate,
      quiet: true,
    });
    const boundRequirements = await readJsonFile(autoPrepared.paths.requirements, "Auto-bound requirements");
    if (boundRequirements.task.validationProfile !== "standard"
      || boundRequirements.numericIntegrity?.state !== "bound"
      || !(await pathExists(autoPrepared.paths.attestation))) {
      throw new Error("Builder integrity registration did not bind and attest a standard source copy in one build");
    }
    steps.push({ name: "builder-integrity-auto-bind", status: "ok", profile: "standard", buildCount: 1 });
  } finally {
    if (autoBindPreviousWorkDir === undefined) delete process.env.PILOTDECK_WORK_DIR;
    else process.env.PILOTDECK_WORK_DIR = autoBindPreviousWorkDir;
  }

  const presentationInputPath = path.join(integrityPhase1Dir, "presentation-input.xlsx");
  const presentationWorkbook = createWorkbook();
  const presentationSheet = presentationWorkbook.addWorksheet("数据");
  presentationSheet.addRows([["项目", "数量", "单价", "金额"], ["A", 2, 10.5, null]]);
  presentationSheet.getCell("D2").value = { formula: "B2*C2", result: 21 };
  await presentationWorkbook.xlsx.writeFile(presentationInputPath);
  const presentationWorkDir = path.join(integrityPhase1Dir, "presentation-turn");
  const presentationPreviousWorkDir = process.env.PILOTDECK_WORK_DIR;
  process.env.PILOTDECK_WORK_DIR = presentationWorkDir;
  try {
    const presentationPrepared = await commandPrepare({
      "final-out": path.join(integrityPhase1Dir, "presentation-final.xlsx"),
      input: presentationInputPath,
      "data-operation": "presentation-only",
      quiet: true,
    });
    const styleOnlyBuilder = `export default async function build({ inputPath, loadWorkbook, helpers }) {\n  const workbook = await loadWorkbook(inputPath);\n  helpers.styleHeader(workbook.getWorksheet("数据"), "A1:D1");\n  return workbook;\n}\n`;
    await fs.writeFile(presentationPrepared.paths.builder, styleOnlyBuilder, "utf8");
    await commandBuild({
      builder: presentationPrepared.paths.builder,
      input: presentationInputPath,
      requirements: presentationPrepared.paths.requirements,
      out: presentationPrepared.paths.candidate,
      quiet: true,
    });
    const presentationCandidateSha256 = await fileSha256(presentationPrepared.paths.candidate);
    const dataChangingBuilder = `export default async function build({ inputPath, loadWorkbook }) {\n  const workbook = await loadWorkbook(inputPath);\n  workbook.getWorksheet("数据").getCell("B2").value = 999;\n  return workbook;\n}\n`;
    await fs.writeFile(presentationPrepared.paths.builder, dataChangingBuilder, "utf8");
    let presentationMutationRejected = false;
    try {
      await commandBuild({
        builder: presentationPrepared.paths.builder,
        input: presentationInputPath,
        requirements: presentationPrepared.paths.requirements,
        out: presentationPrepared.paths.candidate,
        quiet: true,
      });
    } catch (error) {
      presentationMutationRejected = error instanceof SpreadsheetStageError
        && error.stage === "audit"
        && error.message.includes("presentation_only_data_changed");
    }
    if (!presentationMutationRejected || await fileSha256(presentationPrepared.paths.candidate) !== presentationCandidateSha256) {
      throw new Error("Presentation-only validation did not preserve data/formulas or atomically reject a value change");
    }
    steps.push({ name: "presentation-only-fingerprint", status: "ok", styleChangePassed: true, dataChangeRejected: true });
  } finally {
    if (presentationPreviousWorkDir === undefined) delete process.env.PILOTDECK_WORK_DIR;
    else process.env.PILOTDECK_WORK_DIR = presentationPreviousWorkDir;
  }

  const integrityCandidatePath = path.join(integrityPhase1Dir, "candidate.xlsx");
  const integrityCandidate = createWorkbook();
  integrityCandidate.addWorksheet("复制").addRows([["编号", "金额"], ["A-1", 10.25], ["A-2", 20.5]]);
  integrityCandidate.addWorksheet("合表").addRows([["编号", "金额"], ["A-1", 10.25], ["A-2", 20.5], ["B-1", 30.75]]);
  integrityCandidate.addWorksheet("映射").addRows([["编号", "金额", "分类"], ["A-1", 10.25, "甲"], ["A-2", 20.5, "乙"], ["B-1", 30.75, "丙"]]);
  integrityCandidate.addWorksheet("部门汇总").addRows([["部门", "未税合计"], ["甲", 41.75], ["乙", 7.25]]);
  const formulaSheet = integrityCandidate.addWorksheet("公式核算");
  formulaSheet.addRows([
    ["编号", "数量", "单价", "计算金额", "未税金额", "税额", "含税金额"],
    ["X-1", 3, 10.25, null, 30.75, 3.08, null],
    ["X-2", 2, 5.5, null, 11, 1.1, null],
    ["X-3", 1, 7.25, null, 7.25, 0.73, null],
  ]);
  for (let row = 2; row <= 4; row += 1) {
    const quantity = formulaSheet.getCell(`B${row}`).value;
    const unitPrice = formulaSheet.getCell(`C${row}`).value;
    const net = formulaSheet.getCell(`E${row}`).value;
    const tax = formulaSheet.getCell(`F${row}`).value;
    formulaSheet.getCell(`D${row}`).value = { formula: `B${row}*C${row}`, result: quantity * unitPrice };
    formulaSheet.getCell(`G${row}`).value = { formula: `E${row}+F${row}`, result: Number((net + tax).toFixed(2)) };
  }
  integrityCandidate.addWorksheet("图片录入").addRows([["项目", "金额"], ["扫描金额", 1250]]);
  await integrityCandidate.xlsx.writeFile(integrityCandidatePath);
  const integrityWorkDirBefore = process.env.PILOTDECK_WORK_DIR;
  process.env.PILOTDECK_WORK_DIR = integrityPhase1WorkDir;
  try {
    const integrityPrepared = await commandPrepare({
      "final-out": path.join(integrityPhase1Dir, "sealed.xlsx"),
      "workbook-type": "data",
      source: [sourceAPath, sourceBPath, lookupPath, calculationSourcePath, imageSourcePath],
      quiet: true,
    });
    const unboundRequirements = await readJsonFile(integrityPrepared.paths.requirements, "Unbound numeric-integrity requirements");
    let unboundRejected = false;
    try {
      assertNumericIntegrityBound(unboundRequirements);
    } catch (error) {
      unboundRejected = error instanceof SpreadsheetProtocolError && error.code === "numeric-integrity-unbound";
    }
    if (!unboundRejected) throw new Error("Source-backed build did not reject an unbound numeric-integrity plan");
    unboundRequirements.requiredSheets = ["映射"];
    unboundRequirements.minFormulaCount = 2;
    await writeJson(integrityPrepared.paths.requirements, unboundRequirements);
    const originalProjectSnapshot = unboundRequirements.task.projectSnapshot;
    const originalEvidence = unboundRequirements.numericIntegrity.evidence;
    const overwritten = await commandPrepare({
      "final-out": path.join(integrityPhase1Dir, "sealed.xlsx"),
      "workbook-type": "data",
      overwrite: true,
      quiet: true,
    });
    const overwrittenRequirements = await readJsonFile(overwritten.paths.requirements, "Overwritten numeric-integrity requirements");
    if (overwritten.sources.status !== "preserved"
      || overwrittenRequirements.sourceFiles.length !== 5
      || overwrittenRequirements.numericIntegrity.state !== "prepared"
      || overwrittenRequirements.numericIntegrity.evidence.sha256 !== originalEvidence.sha256
      || overwrittenRequirements.task.projectSnapshot.sha256 !== originalProjectSnapshot.sha256
      || overwrittenRequirements.requiredSheets.join(",") !== "映射"
      || overwrittenRequirements.minFormulaCount !== 2) {
      throw new Error("prepare --overwrite dropped frozen sources, acceptance checks, or the original project snapshot");
    }
    steps.push({ name: "prepare-overwrite-preserves-integrity", status: "ok", sources: overwrittenRequirements.sourceFiles.length });
    const scaffoldReport = await commandIntegrityScaffold({
      requirements: integrityPrepared.paths.requirements,
      operation: "union",
      id: "union-scaffold",
      "source-id": ["source-1", "source-2"],
      quiet: true,
    });
    const scaffoldPlan = await readJsonFile(scaffoldReport.plan, "Self-test numeric-integrity scaffold");
    await commandIntegrityScaffold({
      requirements: integrityPrepared.paths.requirements,
      operation: "join",
      id: "join-scaffold",
      "source-id": "source-3",
      "from-operation": "union-scaffold",
      append: true,
      quiet: true,
    });
    const chainedScaffoldPlan = await readJsonFile(scaffoldReport.plan, "Self-test chained numeric-integrity scaffold");
    const scaffoldStatus = await numericIntegrityStatus(integrityPrepared.paths.requirements);
    let draftRejected = false;
    try {
      await commandIntegrityBind({ requirements: integrityPrepared.paths.requirements, quiet: true });
    } catch (error) {
      draftRejected = error instanceof SpreadsheetProtocolError && error.code === "numeric-integrity-plan-draft";
    }
    if (!draftRejected || scaffoldPlan.draft !== true || scaffoldPlan.operations[0]?.inputs?.[0]?.source !== sourceAPath
      || chainedScaffoldPlan.operations[1]?.inputs?.[0]?.operation !== "union-scaffold"
      || !scaffoldStatus.blockers.some((blocker) => blocker.code === "plan-draft")) {
      throw new Error("Numeric-integrity scaffold did not bind frozen sources or block unfinished drafts");
    }
    steps.push({ name: "numeric-integrity-scaffold", status: "ok", operation: scaffoldReport.operation, chained: true });
    await commandEvidenceObserve({
      evidence: integrityPrepared.paths.sourceEvidence,
      source: imageSourcePath,
      "fact-id": "scan-total",
      region: "20,20,160,60",
      method: "vision-model-a",
      "raw-text": "1,250.00",
      value: "1250.00",
      confidence: "0.97",
      quiet: true,
    });
    await commandEvidenceObserve({
      evidence: integrityPrepared.paths.sourceEvidence,
      source: imageSourcePath,
      "fact-id": "scan-total",
      region: "20,20,160,60",
      method: "ocr-engine-b",
      "raw-text": "1250.00",
      value: "1250.00",
      confidence: "0.95",
      quiet: true,
    });
    const integrityPlan = {
      protocol: NUMERIC_INTEGRITY_PROTOCOL,
      mode: "strict",
      draft: false,
      operations: [
        {
          id: "copy-source-a",
          type: "copy",
          fields: {
            id: { semanticType: "identifier" },
            amount: { semanticType: "decimal", scale: 2, currency: "CNY" },
          },
          inputs: [{ source: sourceAPath, sheet: "数据", range: "A2:B3", columns: { id: "A", amount: "B" } }],
          output: { sheet: "复制", range: "A2:B3", columns: { id: "A", amount: "B" } },
          keyColumns: ["id"],
        },
        {
          id: "union-sources",
          type: "union",
          fields: {
            id: { semanticType: "identifier" },
            amount: { semanticType: "decimal", scale: 2, currency: "CNY" },
          },
          inputs: [
            { source: sourceAPath, sheet: "数据", range: "A2:B3", columns: { id: "A", amount: "B" } },
            { source: sourceBPath, sheet: "数据", range: "A2:B2", columns: { id: "A", amount: "B" } },
          ],
          output: { sheet: "合表", range: "A2:B4", columns: { id: "A", amount: "B" } },
          keyColumns: ["id"],
          preserveOrder: true,
        },
        {
          id: "join-category",
          type: "join",
          fields: {
            id: { semanticType: "identifier" },
            amount: { semanticType: "decimal", scale: 2, currency: "CNY" },
            category: { semanticType: "string" },
          },
          inputs: [
            { operation: "union-sources", sheet: "合表", range: "A2:B4", columns: { id: "A", amount: "B" } },
            { source: lookupPath, sheet: "分类", range: "A2:B4", columns: { id: "A", category: "B" } },
          ],
          output: { sheet: "映射", range: "A2:C4", columns: { id: "A", amount: "B", category: "C" } },
          keyColumns: ["id"],
        },
        {
          id: "aggregate-net-by-department",
          type: "aggregate",
          fields: {
            department: { semanticType: "string" },
            net: { semanticType: "decimal", scale: 2, currency: "CNY" },
            totalNet: { semanticType: "decimal", scale: 2, currency: "CNY" },
          },
          inputs: [{ source: calculationSourcePath, sheet: "计算数据", range: "A2:F4", columns: { department: "B", net: "E" } }],
          output: { sheet: "部门汇总", range: "A2:B3", columns: { department: "A", totalNet: "B" } },
          groupBy: ["department"],
          measures: [{ source: "net", target: "totalNet", operator: "sum", rounding: "half-up" }],
        },
        {
          id: "recalculate-row-formulas",
          type: "formula",
          fields: {
            id: { semanticType: "identifier" },
            quantity: { semanticType: "integer" },
            unitPrice: { semanticType: "decimal", scale: 2, currency: "CNY" },
            amount: { semanticType: "decimal", scale: 2, currency: "CNY" },
            net: { semanticType: "decimal", scale: 2, currency: "CNY" },
            tax: { semanticType: "decimal", scale: 2, currency: "CNY" },
            gross: { semanticType: "decimal", scale: 2, currency: "CNY" },
          },
          inputs: [{
            source: calculationSourcePath,
            sheet: "计算数据",
            range: "A2:F4",
            columns: { id: "A", quantity: "C", unitPrice: "D", net: "E", tax: "F" },
          }],
          output: {
            sheet: "公式核算",
            range: "A2:G4",
            columns: { id: "A", quantity: "B", unitPrice: "C", amount: "D", net: "E", tax: "F", gross: "G" },
          },
          keyColumns: ["id"],
          calculations: [
            { target: "amount", expression: "quantity * unitPrice", rounding: "half-up", requireFormula: true },
            { target: "gross", expression: "net + tax", rounding: "half-up", requireFormula: true },
          ],
        },
        {
          id: "capture-image-amount",
          type: "ocr",
          fields: {
            amount: { semanticType: "decimal", scale: 2, currency: "CNY" },
          },
          output: { sheet: "图片录入" },
          facts: [{ evidenceId: "scan-total", cell: "B2", field: "amount" }],
        },
      ],
      invariants: [
        { id: "amount-balance", type: "row-expression", operation: "recalculate-row-formulas", expression: "amount - quantity * unitPrice", expected: "0", scale: 2 },
        { id: "tax-balance", type: "row-expression", operation: "recalculate-row-formulas", expression: "gross - net - tax", expected: "0", scale: 2 },
      ],
      ocrPolicy: {
        minConfidence: 0.9,
        minIndependentObservations: 2,
        allowExplicitUserConfirmation: true,
      },
    };
    let invalidRangeRejected = false;
    try {
      validateNumericIntegrityPlan({
        ...integrityPlan,
        operations: integrityPlan.operations.map((operation) => operation.id === "copy-source-a"
          ? { ...operation, output: { ...operation.output, columns: { ...operation.output.columns, amount: "C" } } }
          : operation),
      });
    } catch (error) {
      invalidRangeRejected = error instanceof Error && error.message.includes("outside A2:B3");
    }
    if (!invalidRangeRejected) throw new Error("Numeric-integrity plan validation accepted a mapped column outside its declared range");
    await writeJson(integrityPrepared.paths.integrityPlan, integrityPlan);
    const readyStatus = await numericIntegrityStatus(integrityPrepared.paths.requirements);
    if (!readyStatus.readyToBind || readyStatus.blockers.length !== 0) {
      throw new Error(`Integrity status did not recognize a bind-ready plan: ${JSON.stringify(readyStatus.blockers)}`);
    }
    await commandIntegrityBind({ requirements: integrityPrepared.paths.requirements, quiet: true });
    let integrityRequirements = await readJsonFile(integrityPrepared.paths.requirements, "Phase 1 numeric-integrity requirements");
    const integrityAudit = await auditXlsx(integrityCandidatePath, integrityRequirements);
    if (integrityAudit.numericIntegrity.status !== "passed" || integrityAudit.status === "error") {
      throw new Error(`Structured numeric integrity did not pass: ${JSON.stringify(integrityAudit.numericIntegrity.failures)}`);
    }
    const tamperedPath = path.join(integrityPhase1Dir, "candidate-tampered.xlsx");
    const tampered = await loadXlsx(integrityCandidatePath);
    tampered.getWorksheet("合表").getCell("B3").value = 999;
    await tampered.xlsx.writeFile(tamperedPath);
    const tamperedAudit = await auditXlsx(tamperedPath, integrityRequirements);
    if (tamperedAudit.numericIntegrity.status !== "failed" || tamperedAudit.status !== "error") {
      throw new Error("Structured numeric integrity did not reject a changed amount");
    }
    const textNumberPath = path.join(integrityPhase1Dir, "candidate-text-number.xlsx");
    const textNumber = await loadXlsx(integrityCandidatePath);
    textNumber.getWorksheet("复制").getCell("B2").value = "10.25";
    await textNumber.xlsx.writeFile(textNumberPath);
    const textNumberAudit = await auditXlsx(textNumberPath, integrityRequirements);
    if (textNumberAudit.numericIntegrity.status !== "failed") {
      throw new Error("Strict numeric integrity accepted a text-formatted number");
    }
    steps.push({
      name: "numeric-integrity-phase1",
      status: "ok",
      operations: integrityAudit.numericIntegrity.operations.filter((operation) => ["copy", "union", "join"].includes(operation.type)).map((operation) => operation.type),
      chainedOperationPassed: integrityAudit.numericIntegrity.operations.some((operation) => operation.id === "join-category" && operation.status === "passed"),
      tamperRejected: true,
      textNumberRejected: true,
    });
    const formulaTamperedPath = path.join(integrityPhase1Dir, "candidate-formula-tampered.xlsx");
    const formulaTampered = await loadXlsx(integrityCandidatePath);
    formulaTampered.getWorksheet("公式核算").getCell("G2").value = { formula: "E2+F2", result: 999 };
    await formulaTampered.xlsx.writeFile(formulaTamperedPath);
    const formulaTamperedAudit = await auditXlsx(formulaTamperedPath, integrityRequirements);
    if (formulaTamperedAudit.numericIntegrity.status !== "failed") {
      throw new Error("Formula integrity accepted an incorrect cached result");
    }
    const hardcodedFormulaPath = path.join(integrityPhase1Dir, "candidate-formula-hardcoded.xlsx");
    const hardcodedFormula = await loadXlsx(integrityCandidatePath);
    hardcodedFormula.getWorksheet("公式核算").getCell("D2").value = 30.75;
    await hardcodedFormula.xlsx.writeFile(hardcodedFormulaPath);
    const hardcodedFormulaAudit = await auditXlsx(hardcodedFormulaPath, integrityRequirements);
    if (hardcodedFormulaAudit.numericIntegrity.status !== "failed") {
      throw new Error("Formula integrity accepted a hardcoded derived value");
    }
    steps.push({
      name: "numeric-integrity-phase2",
      status: "ok",
      operations: integrityAudit.numericIntegrity.operations.filter((operation) => ["aggregate", "formula"].includes(operation.type)).map((operation) => operation.type),
      invariants: integrityAudit.numericIntegrity.checks.filter((check) => check.type === "numeric_invariant").length,
      incorrectFormulaRejected: true,
      hardcodedFormulaRejected: true,
    });
    await commandEvidenceObserve({
      evidence: integrityPrepared.paths.sourceEvidence,
      source: imageSourcePath,
      "fact-id": "scan-total",
      region: "20,20,160,60",
      method: "ocr-engine-b",
      "raw-text": "1251.00",
      value: "1251.00",
      confidence: "0.95",
      overwrite: true,
      quiet: true,
    });
    const staleEvidenceAudit = await auditXlsx(integrityCandidatePath, integrityRequirements);
    if (staleEvidenceAudit.numericIntegrity.status !== "failed"
      || !staleEvidenceAudit.numericIntegrity.checks.some((check) => check.type === "evidence_binding" && !check.passed)) {
      throw new Error("Numeric integrity did not reject evidence changed after binding");
    }
    await commandIntegrityBind({ requirements: integrityPrepared.paths.requirements, quiet: true });
    integrityRequirements = await readJsonFile(integrityPrepared.paths.requirements, "Disagreeing image evidence requirements");
    const disagreementAudit = await auditXlsx(integrityCandidatePath, integrityRequirements);
    if (disagreementAudit.numericIntegrity.status !== "failed"
      || !disagreementAudit.numericIntegrity.operations.some((operation) => operation.type === "ocr" && operation.status === "failed")) {
      throw new Error("OCR integrity did not block disagreeing observations");
    }
    await commandEvidenceConfirm({
      evidence: integrityPrepared.paths.sourceEvidence,
      "fact-id": "scan-total",
      value: "1250.00",
      "confirmed-by": "user",
      quiet: true,
    });
    await commandIntegrityBind({ requirements: integrityPrepared.paths.requirements, quiet: true });
    integrityRequirements = await readJsonFile(integrityPrepared.paths.requirements, "Confirmed image evidence requirements");
    const confirmedAudit = await auditXlsx(integrityCandidatePath, integrityRequirements);
    if (confirmedAudit.numericIntegrity.status !== "passed") {
      throw new Error("Explicit user confirmation did not resolve image evidence disagreement");
    }
    const imageTamperedPath = path.join(integrityPhase1Dir, "candidate-image-tampered.xlsx");
    const imageTampered = await loadXlsx(integrityCandidatePath);
    imageTampered.getWorksheet("图片录入").getCell("B2").value = 1200;
    await imageTampered.xlsx.writeFile(imageTamperedPath);
    const imageTamperedAudit = await auditXlsx(imageTamperedPath, integrityRequirements);
    if (imageTamperedAudit.numericIntegrity.status !== "failed") {
      throw new Error("OCR integrity accepted an output value that differed from confirmed evidence");
    }
    steps.push({
      name: "numeric-integrity-phase3",
      status: "ok",
      regionBound: true,
      staleEvidenceRejected: true,
      independentConsensusPassed: true,
      disagreementRejected: true,
      explicitUserConfirmationPassed: true,
      outputTamperRejected: true,
    });
  } finally {
    if (integrityWorkDirBefore === undefined) delete process.env.PILOTDECK_WORK_DIR;
    else process.env.PILOTDECK_WORK_DIR = integrityWorkDirBefore;
  }

  const recalculation = await recalculateWorkbook(rawPath, finalPath);
  await injectNativeCharts(finalPath, nativeCharts, { JSZip, loadXlsx });
  const recalculated = await loadXlsx(finalPath);
  const margin = recalculated.getWorksheet("汇总").getCell("D4").result;
  const projected = recalculated.getWorksheet("汇总").getCell("B8").result;
  if (Math.abs(Number(margin) - 0.3) > 0.000001 || Math.abs(Number(projected) - 110000) > 0.01) {
    throw new Error(`Formula recalculation failed: margin=${margin}, projected=${projected}`);
  }
  steps.push({ name: "recalculate", status: "ok", margin, projected, compatibilityNormalization: recalculation.compatibilityNormalization });

  const inspection = await inspectXlsx(finalPath, { sheet: "汇总", range: "A1:F8", styles: true });
  if (inspection.formulas.count < 4 || inspection.package.features.tables < 1 || inspection.package.features.charts !== 1) throw new Error("Inspection missed formulas, tables, or native charts");
  if (inspection.package.compatibility.status !== "ok") throw new Error("Inspection missed invalid post-recalculation OOXML semantics");
  if (inspection.package.features.drawingParts !== 1 || inspection.package.features.drawings !== 1) {
    throw new Error(`Drawing cleanup or native chart injection left an unexpected package shape: ${inspection.package.features.drawingParts} parts, ${inspection.package.features.drawings} objects`);
  }
  steps.push({
    name: "inspect",
    status: "ok",
    formulas: inspection.formulas.count,
    tables: inspection.package.features.tables,
    charts: inspection.package.features.charts,
    drawingParts: inspection.package.features.drawingParts,
    drawingObjects: inspection.package.features.drawings,
  });

  const invalidDrawingPath = path.join(outputDir, "invalid-drawing-anchor.xlsx");
  const invalidDrawingZip = await JSZip.loadAsync(await fs.readFile(finalPath));
  let invalidDrawingPart = null;
  for (const [entryName, entry] of Object.entries(invalidDrawingZip.files)) {
    if (entry.dir || !/^xl\/drawings\/[^/]+\.xml$/i.test(entryName) || invalidDrawingPart) continue;
    const xml = await entry.async("string");
    const malformed = xml.replace(
      /<\/a:graphic>\s*<\/xdr:graphicFrame>\s*<xdr:clientData\s*\/>/i,
      "</a:graphic><xdr:clientData/></xdr:graphicFrame>",
    );
    if (malformed === xml) continue;
    invalidDrawingZip.file(entryName, malformed);
    invalidDrawingPart = entryName;
  }
  if (!invalidDrawingPart) throw new Error("Self-test could not create a malformed DrawingML anchor fixture");
  await fs.writeFile(invalidDrawingPath, await invalidDrawingZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const invalidDrawingAudit = await auditXlsx(invalidDrawingPath);
  const invalidDrawingReasons = new Set(invalidDrawingAudit.hardFailures
    .filter((failure) => failure.type === "invalid_drawing_anchor_structure")
    .map((failure) => failure.reason));
  if (!invalidDrawingReasons.has("missing_direct_client_data") || !invalidDrawingReasons.has("nested_client_data")) {
    throw new Error("DrawingML audit did not reject a nested clientData element");
  }

  const missingChartPath = path.join(outputDir, "missing-chart-part.xlsx");
  const missingChartZip = await JSZip.loadAsync(await fs.readFile(finalPath));
  const removedChartPart = Object.keys(missingChartZip.files).find((entryName) => /^xl\/charts\/chart\d+\.xml$/i.test(entryName));
  if (!removedChartPart) throw new Error("Self-test could not locate the native chart part");
  missingChartZip.remove(removedChartPart);
  await fs.writeFile(missingChartPath, await missingChartZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const missingChartAudit = await auditXlsx(missingChartPath);
  if (!missingChartAudit.hardFailures.some((failure) => failure.type === "missing_chart_part" && failure.part === removedChartPart)) {
    throw new Error("DrawingML audit did not reject a dangling chart relationship");
  }
  steps.push({
    name: "drawingml-compatibility",
    status: "ok",
    malformedAnchorIssues: invalidDrawingAudit.package.compatibility.issues.length,
    danglingRelationshipIssues: missingChartAudit.package.compatibility.issues.length,
  });

  const emptyDrawingPath = path.join(outputDir, "empty-drawing-part.xlsx");
  const emptyDrawingZip = await JSZip.loadAsync(await fs.readFile(rawPath));
  const emptyDrawingRelationshipId = "rIdPilotDeckEmptyDrawing";
  const emptyDrawingPart = "xl/drawings/drawing999.xml";
  const emptyDrawingSheetPart = "xl/worksheets/sheet1.xml";
  const emptyDrawingSheetRelsPart = "xl/worksheets/_rels/sheet1.xml.rels";
  const emptyDrawingSheetXml = await emptyDrawingZip.file(emptyDrawingSheetPart).async("string");
  emptyDrawingZip.file(emptyDrawingSheetPart, emptyDrawingSheetXml.replace("</worksheet>", `<drawing r:id="${emptyDrawingRelationshipId}"/></worksheet>`));
  const emptyDrawingRelationshipXml = emptyDrawingZip.file(emptyDrawingSheetRelsPart)
    ? await emptyDrawingZip.file(emptyDrawingSheetRelsPart).async("string")
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  emptyDrawingZip.file(emptyDrawingSheetRelsPart, emptyDrawingRelationshipXml.replace(
    "</Relationships>",
    `<Relationship Id="${emptyDrawingRelationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing999.xml"/></Relationships>`,
  ));
  emptyDrawingZip.file(emptyDrawingPart, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"></xdr:wsDr>');
  const emptyDrawingContentTypes = await emptyDrawingZip.file("[Content_Types].xml").async("string");
  emptyDrawingZip.file("[Content_Types].xml", emptyDrawingContentTypes.replace(
    "</Types>",
    `<Override PartName="/${emptyDrawingPart}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`,
  ));
  await fs.writeFile(emptyDrawingPath, await emptyDrawingZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const emptyDrawingNormalization = await normalizeLibreOfficeRoundTripPackage(emptyDrawingPath);
  const cleanedEmptyDrawingZip = await JSZip.loadAsync(await fs.readFile(emptyDrawingPath));
  const cleanedSheetXml = await cleanedEmptyDrawingZip.file(emptyDrawingSheetPart).async("string");
  const cleanedSheetRelsXml = cleanedEmptyDrawingZip.file(emptyDrawingSheetRelsPart)
    ? await cleanedEmptyDrawingZip.file(emptyDrawingSheetRelsPart).async("string")
    : "";
  const cleanedContentTypes = await cleanedEmptyDrawingZip.file("[Content_Types].xml").async("string");
  if (emptyDrawingNormalization.removedEmptyDrawings !== 1
    || cleanedEmptyDrawingZip.file(emptyDrawingPart)
    || cleanedSheetXml.includes(emptyDrawingRelationshipId)
    || cleanedSheetRelsXml.includes(emptyDrawingRelationshipId)
    || cleanedContentTypes.includes(`/${emptyDrawingPart}`)) {
    throw new Error("Empty DrawingML package cleanup left an orphan part or relationship");
  }
  steps.push({ name: "empty-drawing-cleanup", status: "ok", removed: emptyDrawingNormalization.removedEmptyDrawings });

  const incompatibleValidationPath = path.join(outputDir, "invalid-list-validation.xlsx");
  const incompatibleValidationZip = await JSZip.loadAsync(await fs.readFile(rawPath));
  let injectedInvalidValidation = false;
  for (const [entryName, entry] of Object.entries(incompatibleValidationZip.files)) {
    if (entry.dir || !/^xl\/worksheets\/sheet\d+\.xml$/i.test(entryName) || injectedInvalidValidation) continue;
    const xml = await entry.async("string");
    const invalid = xml.replace(
      /(<(?:(?:[A-Za-z_][\w.-]*):)?dataValidation\b)([^>]*\btype=(["'])list\3[^>]*>)([\s\S]*?)(<\/(?:(?:[A-Za-z_][\w.-]*):)?dataValidation\s*>)/i,
      (_match, opening, attributes, _quote, body, closing) => `${opening} operator="between"${attributes}${body}<formula2>0</formula2>${closing}`,
    );
    if (invalid === xml) continue;
    incompatibleValidationZip.file(entryName, invalid);
    injectedInvalidValidation = true;
  }
  if (!injectedInvalidValidation) throw new Error("Self-test could not create an invalid list-validation fixture");
  await fs.writeFile(incompatibleValidationPath, await incompatibleValidationZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const incompatibleValidationAudit = await auditXlsx(incompatibleValidationPath);
  if (!incompatibleValidationAudit.hardFailures.some((failure) => failure.type === "invalid_data_validation_semantics")) {
    throw new Error("Audit did not reject invalid list-validation OOXML semantics");
  }
  const fixtureNormalization = await normalizeLibreOfficeRoundTripPackage(incompatibleValidationPath);
  const repairedValidationAudit = await auditXlsx(incompatibleValidationPath);
  if (fixtureNormalization.normalizedValidations !== 1 || repairedValidationAudit.package.compatibility.status !== "ok") {
    throw new Error("List-validation OOXML normalization did not repair the invalid fixture");
  }
  steps.push({
    name: "list-validation-compatibility",
    status: "ok",
    detected: incompatibleValidationAudit.package.compatibility.issues.length,
    normalized: fixtureNormalization.normalizedValidations,
  });

  const prefixedPath = path.join(outputDir, "prefixed-main-namespace.xlsx");
  const prefixedZip = await JSZip.loadAsync(await fs.readFile(rawPath));
  let prefixedPartCount = 0;
  for (const [entryName, entry] of Object.entries(prefixedZip.files)) {
    if (entry.dir || !entryName.endsWith(".xml")) continue;
    const xml = await entry.async("string");
    const defaultNamespace = `xmlns="${SPREADSHEET_MAIN_NAMESPACE}"`;
    if (!xml.includes(defaultNamespace)) continue;
    const prefixed = xml
      .replace(defaultNamespace, `xmlns:x="${SPREADSHEET_MAIN_NAMESPACE}"`)
      .replace(/(<\/?)([A-Za-z_][\w.-]*)(?=[\s/>])/g, "$1x:$2");
    prefixedZip.file(entryName, prefixed);
    prefixedPartCount += 1;
  }
  await fs.writeFile(prefixedPath, await prefixedZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const prefixedInspection = await inspectXlsx(prefixedPath, { sheet: "汇总", range: "A1:F8" });
  if (prefixedPartCount === 0 || prefixedInspection.selection.cells.length === 0) {
    throw new Error("Inspection failed for prefixed SpreadsheetML namespaces");
  }
  steps.push({ name: "inspect-prefixed-ooxml", status: "ok", normalizedParts: prefixedPartCount });

  const selfTestRequirements = {
    task: {
      protocol: TASK_PROTOCOL,
      workbookType: "template",
      styleMode: "preserve-source",
      validationProfile: "standard",
      minimumValidationProfile: "standard",
      dataOperation: "copy",
      profileReasons: ["self-test source copy uses standard validation"],
      input: { path: rawPath, sha256: await fileSha256(rawPath) },
      finalOutput: sealedPath,
      visualReview: { mode: "all-pages" },
      allowDecorativeTitle: true,
      allowedAccentColors: [],
    },
    sourceBacked: true,
    sourceFiles: [{ path: rawPath, sha256: await fileSha256(rawPath) }],
    sourceBackedSheets: ["汇总", "类型回归"],
    requiredSheets: ["输入数据", "汇总", "类型回归"],
    minFormulaCount: 4,
    requiredFormulaRanges: [{ sheet: "汇总", range: "D4:D6" }],
    requiredNativeCharts: [{ sheet: "汇总", type: "line", minPoints: 3, sourceRanges: ["A4:A6", "B4:B6", "C4:C6"] }],
    requiredTables: [{ sheet: "汇总", minCount: 1 }],
    requiredConditionalFormatting: [{ sheet: "汇总", range: "D4:D6" }],
    requiredDataValidations: [{ sheet: "汇总", cell: "F4" }],
    requiredCellTypes: [
      { sheet: "汇总", range: "A4:A6", type: "string" },
      { sheet: "汇总", range: "B4:D6", type: "number" },
      { sheet: "类型回归", range: "A2:A3", type: "string" },
      { sheet: "类型回归", range: "B2:B3", type: "number" },
      { sheet: "类型回归", range: "C2:C3", type: "date" },
    ],
    expectedCells: [{ sheet: "汇总", cell: "B8", value: 110000, tolerance: 0.01 }],
    expectedRanges: [
      { sheet: "汇总", range: "A4:C6", values: [["1月", 100000, 70000], ["2月", 120000, 78000], ["3月", 135000, 85000]] },
      { sheet: "类型回归", range: "A2:D3", values: [["A-001", 0.5, "2026-04-30", "进行中"], ["A-002", 0.8, "2026-05-31", "已完成"]] },
    ],
  };
  const audit = await auditXlsx(finalPath, selfTestRequirements);
  if (audit.status === "error") throw new Error("Clean workbook failed audit");
  if (audit.coverage.status !== "passed") throw new Error("Self-test requirement coverage failed");
  if (audit.warnings.some((warning) => warning.type === "cjk_font_fallback")) throw new Error("Chinese font fallback remained unresolved after recalculation");
  steps.push({ name: "audit-clean", status: audit.status, coverage: audit.coverage.status });

  const neutralWorkbook = createWorkbook();
  const neutralSheet = neutralWorkbook.addWorksheet("数据");
  neutralSheet.addRows([["名称", "数值"], ["测试", 1]]);
  styleHeader(neutralSheet, "A1:B1");
  const neutralPath = path.join(outputDir, "neutral-style.xlsx");
  await neutralWorkbook.xlsx.writeFile(neutralPath);
  const neutralRequirements = {
    task: {
      protocol: TASK_PROTOCOL,
      workbookType: "data",
      styleMode: "neutral-built-in",
      finalOutput: path.join(outputDir, "neutral-final.xlsx"),
      visualReview: { mode: "all-pages" },
      allowDecorativeTitle: false,
      allowedAccentColors: [],
    },
    requiredSheets: ["数据"],
    expectedRanges: [{ sheet: "数据", range: "A1:B2", values: [["名称", "数值"], ["测试", 1]] }],
  };
  const neutralAudit = await auditXlsx(neutralPath, neutralRequirements);
  if (neutralAudit.status === "error" || neutralSheet.getCell("A1").fill?.fgColor?.argb !== "FFF3F4F6") {
    throw new Error("Neutral built-in spreadsheet style did not pass its audit");
  }
  const alternateNeutralWorkbook = createWorkbook();
  const alternateNeutralSheet = alternateNeutralWorkbook.addWorksheet("数据");
  alternateNeutralSheet.addRows([["名称", "数值"], ["测试", 1]]);
  alternateNeutralSheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7E6E6" } };
  const alternateNeutralPath = path.join(outputDir, "alternate-neutral-style.xlsx");
  await alternateNeutralWorkbook.xlsx.writeFile(alternateNeutralPath);
  const alternateNeutralAudit = await auditXlsx(alternateNeutralPath, neutralRequirements);
  if (alternateNeutralAudit.hardFailures.some((failure) => failure.type === "unrequested_chromatic_fill")) {
    throw new Error("Low-saturation light gray was incorrectly rejected as a chromatic fill");
  }
  const decoratedWorkbook = createWorkbook();
  const decoratedSheet = decoratedWorkbook.addWorksheet("数据");
  decoratedSheet.mergeCells("A1:D1");
  decoratedSheet.getCell("A1").value = "不应出现的大标题";
  decoratedSheet.getCell("A1").font = { size: 20, bold: true };
  decoratedSheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
  decoratedSheet.addRows([["名称", "数值"], ["测试", 1]]);
  addTableFromRange(decoratedSheet, { name: "ColoredTable", range: "A2:B3", style: { theme: "TableStyleMedium2", showRowStripes: true } });
  const decoratedPath = path.join(outputDir, "decorated-style.xlsx");
  await decoratedWorkbook.xlsx.writeFile(decoratedPath);
  const decoratedAudit = await auditXlsx(decoratedPath, { ...neutralRequirements, requiredSheets: ["数据"], expectedRanges: [] });
  const decoratedTypes = new Set(decoratedAudit.hardFailures.map((failure) => failure.type));
  if (!decoratedTypes.has("unrequested_chromatic_fill") || !decoratedTypes.has("unrequested_oversized_title") || !decoratedTypes.has("unrequested_colored_table_style")) {
    throw new Error("Neutral style audit did not reject decorative blue title formatting");
  }
  steps.push({ name: "neutral-style-policy", status: "ok", rejected: [...decoratedTypes].filter((type) => type.startsWith("unrequested_")) });

  const destructiveTableWorkbook = createWorkbook();
  const destructiveTableSheet = destructiveTableWorkbook.addWorksheet("明细");
  destructiveTableSheet.addRows([["项目", "金额"], ["A", 10], ["B", 20]]);
  let destructiveTableError = null;
  try {
    destructiveTableSheet.addTable({
      name: "UnsafeTable",
      ref: "A1",
      headerRow: true,
      totalsRow: false,
      columns: [{ name: "项目" }, { name: "金额" }],
      rows: [[null, null], [null, null]],
    });
  } catch (error) {
    destructiveTableError = error;
  }
  if (!destructiveTableError?.message.includes("helpers.addTableFromRange") || destructiveTableSheet.getCell("B2").value !== 10) {
    throw new Error("Destructive raw worksheet.addTable call was not rejected before overwriting populated cells");
  }
  steps.push({ name: "destructive-table-guard", status: "ok" });

  const preflightWorkbook = createWorkbook();
  const preflightSheet = preflightWorkbook.addWorksheet("汇总");
  preflightSheet.getCell("B2").value = { formula: "1+1", result: 0 };
  let formulaRangePreflightError = null;
  try {
    validateWorkbookRequirementsPreflight(preflightWorkbook, {
      requiredSheets: ["汇总"],
      requiredFormulaRanges: [{ sheet: "汇总", range: "B2:C2" }],
      expectedCells: [{ sheet: "汇总", cell: "A1", value: null }],
    });
  } catch (error) {
    formulaRangePreflightError = error;
  }
  let cellTypePreflightError = null;
  try {
    validateWorkbookRequirementsPreflight(preflightWorkbook, {
      requiredFormulaRanges: [{ sheet: "汇总", range: "B2" }],
      requiredCellTypes: [{ sheet: "汇总", range: "B2", type: "string" }],
    });
  } catch (error) {
    cellTypePreflightError = error;
  }
  if (!formulaRangePreflightError?.message.includes("requirement:required_formula_range") || !cellTypePreflightError?.message.includes("requirement:required_cell_type")) {
    throw new Error("Requirements preflight did not reject an impossible formula range or formula result type");
  }
  steps.push({ name: "requirements-preflight", status: "ok" });

  const formulaTableChartWorkbook = createWorkbook();
  const formulaTableSource = formulaTableChartWorkbook.addWorksheet("数据");
  formulaTableSource.addRows([["月份", "数值"], ["1月", 10], ["2月", 0], ["3月", 20]]);
  addTableFromRange(formulaTableSource, { name: "SourceValues", range: "A1:B4" });
  const formulaTableSummary = formulaTableChartWorkbook.addWorksheet("汇总");
  formulaTableSummary.addRows([["月份", "数值"], ["1月", null], ["2月", null], ["3月", null]]);
  for (let row = 2; row <= 4; row += 1) formulaTableSummary.getCell(`B${row}`).value = { formula: `'数据'!B${row}` };
  addTableFromRange(formulaTableSummary, { name: "FormulaSummary", range: "A1:B4" });
  const formulaTableRawPath = path.join(outputDir, "formula-table-chart-raw.xlsx");
  const formulaTablePath = path.join(outputDir, "formula-table-chart.xlsx");
  await formulaTableChartWorkbook.xlsx.writeFile(formulaTableRawPath);
  await recalculateWorkbook(formulaTableRawPath, formulaTablePath);
  await injectNativeCharts(formulaTablePath, [{
    sheet: "汇总",
    type: "line",
    title: "含零值的公式趋势",
    minPoints: 3,
    categories: "A2:A4",
    series: [{ name: "数值", values: "B2:B4" }],
    anchor: { from: "D1", to: "K14" },
  }], { JSZip, loadXlsx });
  const formulaTableAudit = await auditXlsx(formulaTablePath, {
    requiredSheets: ["数据", "汇总"],
    minFormulaCount: 3,
    requiredFormulaRanges: [{ sheet: "汇总", range: "B2:B4" }],
    expectedRanges: [{ sheet: "汇总", range: "A2:B4", values: [["1月", 10], ["2月", 0], ["3月", 20]] }],
    requiredCellTypes: [{ sheet: "汇总", range: "B2:B4", type: "number" }],
    requiredNativeCharts: [{ sheet: "汇总", type: "line", minPoints: 3, sourceRanges: ["A2:A4", "B2:B4"] }],
    requiredTables: [{ sheet: "汇总", minCount: 1 }],
  });
  if (formulaTableAudit.status === "error" || formulaTableAudit.formulas.missingCachedResults.length > 0) {
    throw new Error(`Formula-backed table/chart regression failed: ${summarizeAuditFailures(formulaTableAudit)}`);
  }
  steps.push({ name: "formula-table-chart-zero-cache", status: "ok", formulas: formulaTableAudit.formulas.count, charts: formulaTableAudit.package.features.charts });

  const imageAssetPath = path.join(outputDir, "image-source.png");
  await sharp({ create: { width: 160, height: 90, channels: 3, background: { r: 80, g: 90, b: 100 } } }).png().toFile(imageAssetPath);
  const imageWorkbook = createWorkbook();
  const imageSheet = imageWorkbook.addWorksheet("插图");
  imageSheet.addRows([["项目", "说明"], ["A", "本地图片"]]);
  await addImage(imageWorkbook, { sheet: "插图", path: imageAssetPath, anchor: { from: "D2", to: "H10" } });
  const imagePath = path.join(outputDir, "image-workbook.xlsx");
  await imageWorkbook.xlsx.writeFile(imagePath);
  const imageAudit = await auditXlsx(imagePath, { requiredSheets: ["插图"], requiredImages: [{ sheet: "插图", minCount: 1 }] });
  if (imageAudit.status === "error" || imageAudit.package.features.media !== 1) throw new Error("Standard raster image helper failed workbook audit");
  steps.push({ name: "raster-image-helper", status: "ok", media: imageAudit.package.features.media });

  const fallbackScriptPath = path.join(outputDir, "fallback-patch.mjs");
  await fs.writeFile(fallbackScriptPath, `import fs from "node:fs/promises";\nimport path from "node:path";\nconst index = process.argv.indexOf("--package-dir");\nif (index < 0) throw new Error("missing package dir");\nconst target = path.join(process.argv[index + 1], "docProps", "core.xml");\nconst xml = await fs.readFile(target, "utf8");\nawait fs.writeFile(target, xml.replace("PilotDeck", "PilotDeck Controlled Fallback"), "utf8");\n`, "utf8");
  const fallbackOutputPath = path.join(outputDir, "fallback-output.xlsx");
  const fallbackManifestPath = path.join(outputDir, "fallback-manifest.json");
  await commandFallbackPatch({
    input: rawPath,
    script: fallbackScriptPath,
    out: fallbackOutputPath,
    manifest: fallbackManifestPath,
    reason: "Self-test verifies the controlled package-part allowlist.",
    "allow-part": "docProps/core.xml",
    quiet: true,
  });
  const fallbackManifest = await readJsonFile(fallbackManifestPath, "Self-test fallback manifest");
  if (
    fallbackManifest.status !== "ok"
    || fallbackManifest.changedParts.join(",") !== "docProps/core.xml"
    || !globPatternMatches("xl/charts/chart*.xml", "xl/charts/chart12.xml")
    || globPatternMatches("xl/charts/chart*.xml", "xl/drawings/drawing1.xml")
  ) {
    throw new Error("Controlled fallback did not preserve its declared package-part scope");
  }
  steps.push({ name: "controlled-fallback", status: "ok", changedParts: fallbackManifest.changedParts });

  const wrongFactRequirements = structuredClone(selfTestRequirements);
  wrongFactRequirements.expectedRanges[0].values[0][1] = 999999;
  const wrongFactAudit = await auditXlsx(finalPath, wrongFactRequirements);
  if (!wrongFactAudit.coverage.failures.some((failure) => failure.type === "expected_range" && failure.mismatches?.[0]?.address === "B4")) {
    throw new Error("Expected-range coverage did not reject a source-fact mismatch");
  }

  const changedSourcePath = path.join(outputDir, "changed-source.xlsx");
  await fs.copyFile(rawPath, changedSourcePath);
  const changedSourceHash = await fileSha256(changedSourcePath);
  await fs.appendFile(changedSourcePath, "changed");
  const changedSourceRequirements = structuredClone(selfTestRequirements);
  changedSourceRequirements.sourceFiles = [{ path: changedSourcePath, sha256: changedSourceHash }];
  const changedSourceAudit = await auditXlsx(finalPath, changedSourceRequirements);
  if (!changedSourceAudit.coverage.failures.some((failure) => failure.type === "source_file_integrity")) {
    throw new Error("Source-file integrity coverage did not reject a changed input");
  }
  steps.push({ name: "source-fact-coverage", status: "ok", expectedRangeFailures: wrongFactAudit.coverage.failures.length, sourceHashFailures: changedSourceAudit.coverage.failures.length });
  const failedCoverage = await auditXlsx(finalPath, { requiredNativeCharts: [{ sheet: "汇总", type: "bar", minCount: 1 }] });
  if (failedCoverage.status !== "error" || failedCoverage.coverage.status !== "failed") throw new Error("Requirement coverage did not reject a missing native chart type");
  steps.push({ name: "coverage-failure", status: "ok", detected: failedCoverage.coverage.failures.length });
  const failedTypeCoverage = await auditXlsx(finalPath, { requiredCellTypes: [{ sheet: "类型回归", range: "B2:B3", type: "date" }] });
  if (failedTypeCoverage.status !== "error" || failedTypeCoverage.coverage.failures[0]?.type !== "required_cell_type") {
    throw new Error("Cell type coverage did not reject numeric KPI cells interpreted as dates");
  }
  steps.push({ name: "cell-type-coverage", status: "ok", detected: failedTypeCoverage.coverage.failures.length });

  const editBuilderPath = path.join(outputDir, "edit-builder.mjs");
  await fs.writeFile(editBuilderPath, `export default async function build({ inputPath, loadWorkbook }) {\n  const workbook = await loadWorkbook(inputPath);\n  workbook.getWorksheet("汇总").getCell("A1").value = "Edited workbook";\n  return workbook;\n}\n`, "utf8");
  const editedProduct = await buildFromBuilder(editBuilderPath, finalPath);
  const editedRawPath = path.join(outputDir, "edited-raw.xlsx");
  const editedPath = path.join(outputDir, "edited.xlsx");
  await editedProduct.workbook.xlsx.writeFile(editedRawPath);
  await recalculateWorkbook(editedRawPath, editedPath);
  const sourceAfterEdit = await loadXlsx(finalPath);
  const editedWorkbook = await loadXlsx(editedPath);
  if (displayCellText(sourceAfterEdit.getWorksheet("汇总").getCell("A1")) !== "PilotDeck 表格能力自测") {
    throw new Error("Existing-workbook edit overwrote the source file");
  }
  if (editedWorkbook.getWorksheet("汇总").getCell("A1").value !== "Edited workbook") {
    throw new Error("Existing-workbook edit did not reach the output file");
  }
  steps.push({ name: "edit-copy", status: "ok" });

  const errorPath = path.join(outputDir, "formula-error.xlsx");
  const errorWorkbook = createWorkbook();
  const errorSheet = errorWorkbook.addWorksheet("Errors");
  errorSheet.getCell("A1").value = { error: "#DIV/0!" };
  await errorWorkbook.xlsx.writeFile(errorPath);
  const errorAudit = await auditXlsx(errorPath);
  if (errorAudit.status !== "error") throw new Error("Formula error scan did not catch #DIV/0!");
  steps.push({ name: "audit-error", status: "ok", detected: errorAudit.hardFailures.length });

  const invalidDatePath = path.join(outputDir, "invalid-date.xlsx");
  const invalidDateWorkbook = createWorkbook();
  const invalidDateSheet = invalidDateWorkbook.addWorksheet("InvalidDate");
  invalidDateSheet.getCell("A1").value = 1e20;
  invalidDateSheet.getCell("A1").numFmt = "yyyy-mm-dd";
  await invalidDateWorkbook.xlsx.writeFile(invalidDatePath);
  const invalidDateAudit = await auditXlsx(invalidDatePath);
  if (!invalidDateAudit.hardFailures.some((failure) => failure.type === "invalid_date_value")) {
    throw new Error("Invalid date scan did not catch an out-of-range date-formatted number");
  }
  steps.push({ name: "invalid-date-audit", status: "ok", detected: invalidDateAudit.invalidDates.length });

  const blankPath = path.join(outputDir, "intentional-blank-sheet.xlsx");
  const blankWorkbook = createWorkbook();
  blankWorkbook.addWorksheet("Blank");
  await blankWorkbook.xlsx.writeFile(blankPath);
  const unresolvedWarningAudit = await auditXlsx(blankPath, { requiredSheets: ["Blank"] });
  if (unresolvedWarningAudit.warningDispositions.status !== "failed") throw new Error("Unresolved warnings were not marked as blocking");
  const disposedWarningAudit = await auditXlsx(blankPath, {
    requiredSheets: ["Blank"],
    warningDispositions: [{ type: "blank_sheets", rationale: "Self-test fixture intentionally verifies warning dispositions." }],
  });
  if (disposedWarningAudit.warningDispositions.status !== "passed") throw new Error("Explicit warning disposition was not accepted");
  steps.push({ name: "warning-dispositions", status: "ok" });

  const invalidRequirementMessages = [];
  for (const invalid of [
    { coverage: { status: "passed" } },
    { warningDispositions: { cjk_font_fallback: "invalid shape" } },
    {
      sourceBacked: true,
      sourceFiles: [{ path: path.join(outputDir, "source.xlsx"), sha256: "0".repeat(64) }],
      sourceBackedSheets: ["无断言"],
    },
  ]) {
    try {
      validateRequirements(invalid, "self-test requirements");
    } catch (error) {
      invalidRequirementMessages.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (invalidRequirementMessages.length !== 3 || !invalidRequirementMessages.some((message) => message.includes("requires expectedCells/expectedRanges or bound numericIntegrity coverage"))) {
    throw new Error("Malformed or shallow source-backed requirements were not rejected deterministically");
  }
  steps.push({ name: "requirements-schema", status: "ok", detected: invalidRequirementMessages.length });

  const invalidConditionalBuilderPath = path.join(outputDir, "invalid-conditional-builder.mjs");
  await fs.writeFile(invalidConditionalBuilderPath, `export default async function build({ createWorkbook }) {\n  const workbook = createWorkbook();\n  const sheet = workbook.addWorksheet("行动项");\n  sheet.addConditionalFormatting({ ref: "A1:A2", rules: [{ type: "expression", formula: ["A1>0"], style: {} }] });\n  return { workbook, requirements: { requiredSheets: ["行动项"] } };\n}\n`, "utf8");
  let conditionalValidationError;
  try {
    await commandBuild({ builder: invalidConditionalBuilderPath, out: path.join(outputDir, "invalid-conditional.xlsx") });
  } catch (error) {
    conditionalValidationError = error;
  }
  if (!(conditionalValidationError instanceof SpreadsheetStageError)
    || conditionalValidationError.stage !== "builder_validation"
    || !conditionalValidationError.message.includes(".formulae as an array")) {
    throw new Error("Invalid conditional-formatting formulas did not produce an actionable builder-validation error");
  }
  steps.push({ name: "builder-validation", status: "ok", stage: conditionalValidationError.stage });

  const nullFormulaPath = path.join(outputDir, "missing-formula-cache.xlsx");
  const nullFormulaWorkbook = createWorkbook();
  nullFormulaWorkbook.addWorksheet("Formula").getCell("A1").value = { formula: "1+1" };
  await nullFormulaWorkbook.xlsx.writeFile(nullFormulaPath);
  const nullFormulaAudit = await auditXlsx(nullFormulaPath);
  if (!nullFormulaAudit.hardFailures.some((failure) => failure.type === "missing_cached_formula_result" && failure.address === "A1")) {
    throw new Error("Missing formula cache was not reported as a hard failure");
  }
  steps.push({ name: "missing-formula-cache", status: "ok", detected: nullFormulaAudit.formulas.missingCachedResults.length });

  const blankMergePath = path.join(outputDir, "blank-merge.xlsx");
  const blankMergeWorkbook = createWorkbook();
  const blankMergeSheet = blankMergeWorkbook.addWorksheet("Merged");
  blankMergeSheet.mergeCells("A1:B1");
  blankMergeSheet.getCell("C1").value = "keeps sheet populated";
  await blankMergeWorkbook.xlsx.writeFile(blankMergePath);
  const blankMergeAudit = await auditXlsx(blankMergePath);
  if (blankMergeAudit.status === "error") throw new Error("Blank merged cells crashed or failed workbook audit");
  steps.push({ name: "blank-merge-audit", status: "ok" });

  const atomicCandidatePath = path.join(outputDir, "atomic-candidate.xlsx");
  await fs.copyFile(finalPath, atomicCandidatePath);
  const atomicCandidateHash = await fileSha256(atomicCandidatePath);
  const failingBuilderPath = path.join(outputDir, "failing-builder.mjs");
  await fs.writeFile(failingBuilderPath, `export default async function build({ createWorkbook }) {\n  const workbook = createWorkbook();\n  workbook.addWorksheet("Broken").getCell("A1").value = { error: "#DIV/0!" };\n  return { workbook, requirements: { requiredSheets: ["Broken"], expectedCells: [{ sheet: "Broken", cell: "A1", value: "#DIV/0!" }] } };\n}\n`, "utf8");
  let buildRejected = false;
  try {
    await commandBuild({ builder: failingBuilderPath, out: atomicCandidatePath });
  } catch {
    buildRejected = true;
  }
  if (!buildRejected || await fileSha256(atomicCandidatePath) !== atomicCandidateHash) {
    throw new Error("Failed build replaced the last valid candidate");
  }
  const failedBuildReportPath = `${atomicCandidatePath}.build-report.json`;
  const failedBuildDir = `${atomicCandidatePath}.failed`;
  const failedBuildReport = await readJsonFile(failedBuildReportPath, "Failed build report");
  if (
    failedBuildReport.status !== "error"
    || failedBuildReport.outputUpdated !== false
    || !(await pathExists(path.join(failedBuildDir, "raw.xlsx")))
    || !(await pathExists(path.join(failedBuildDir, "staged.xlsx")))
    || !(await pathExists(path.join(failedBuildDir, "audit.json")))
  ) {
    throw new Error("Failed build did not preserve a complete internal diagnostic bundle");
  }
  const groupedSummary = summarizeFailures([
    { type: "missing_cached_formula_result", sheet: "S", address: "A1" },
    { type: "missing_cached_formula_result", sheet: "S", address: "A2" },
    { type: "requirement_not_met", requirement: { type: "expected_cell", sheet: "S", cell: "B1", expected: 1, actual: 2 } },
    { type: "unrequested_chromatic_fill", sheet: "S", address: "C1", color: "FF4472C4" },
  ]);
  if (!groupedSummary.includes("missing_cached_formula_result ×2") || !groupedSummary.includes("requirement:expected_cell") || !groupedSummary.includes("unrequested_chromatic_fill")) {
    throw new Error("Grouped failure summary hid one or more independent failure categories");
  }
  steps.push({ name: "atomic-failed-build", status: "ok", report: failedBuildReportPath, artifacts: failedBuildDir });

  const csvPath = path.join(outputDir, "sample-gb18030.csv");
  await fs.writeFile(csvPath, iconv.encode('名称,编号,数值\n"北京分公司",001234,10\n上海分公司,123456789012345678,20\n', "gb18030"));
  const csvInspection = await inspectDelimited(csvPath, {});
  if (csvInspection.rowCount !== 3 || csvInspection.preview[1][0] !== "北京分公司" || csvInspection.encoding !== "gb18030") throw new Error("Chinese CSV encoding detection failed");
  const csvWorkbook = await loadDelimited(csvPath, { inferTypes: true });
  if (typeof csvWorkbook.worksheets[0].getCell("B2").value !== "string" || typeof csvWorkbook.worksheets[0].getCell("B3").value !== "string") {
    throw new Error("CSV identifier inference lost leading zeroes or long integer precision");
  }
  const tsvPath = path.join(outputDir, "sample.tsv");
  await exportDelimited(csvWorkbook, tsvPath);
  const tsvInspection = await inspectDelimited(tsvPath, {});
  if (tsvInspection.format !== "tsv" || tsvInspection.preview[1][0] !== "北京分公司" || tsvInspection.encoding !== "utf8-bom") throw new Error("TSV export failed");
  steps.push({ name: "csv-tsv", status: "ok", sourceEncoding: csvInspection.encoding, outputEncoding: tsvInspection.encoding });

  const riskyPath = path.join(outputDir, "risky-chart-package.xlsx");
  const riskyZip = await JSZip.loadAsync(await fs.readFile(rawPath));
  riskyZip.file("xl/charts/chart1.xml", '<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:lineChart/></c:plotArea></c:chart></c:chartSpace>');
  await fs.writeFile(riskyPath, await riskyZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const riskyInfo = await inspectPackage(riskyPath);
  if (!riskyInfo.unsafeForRoundTrip || riskyInfo.features.charts !== 1) throw new Error("Chart compatibility preflight failed");
  steps.push({ name: "compatibility-preflight", status: "ok", risks: riskyInfo.roundTripRisks });

  const chartTypesPath = path.join(outputDir, "native-chart-types.xlsx");
  const chartTypesWorkbook = createWorkbook();
  const chartTypeSpecs = [];
  for (const type of ["line", "column", "bar"]) {
    const worksheet = chartTypesWorkbook.addWorksheet(type, { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 1 } });
    worksheet.addRows([["月份", "实际", "目标"], ["1月", 10, 12], ["2月", 14, 13], ["3月", 16, 15]]);
    styleHeader(worksheet, "A1:C1");
    autoFitColumns(worksheet, { min: 10, max: 18 });
    applyChineseTypography(worksheet, { platform: "cross-platform" });
    chartTypeSpecs.push({ sheet: type, type, title: `${type} 原生图表`, minPoints: 3, categories: "A2:A4", series: [{ name: "实际", values: "B2:B4" }, { name: "目标", values: "C2:C4" }], anchor: { from: "A6", to: "H20" } });
  }
  await chartTypesWorkbook.xlsx.writeFile(chartTypesPath);
  await injectNativeCharts(chartTypesPath, chartTypeSpecs, { JSZip, loadXlsx });
  const chartTypesAudit = await auditXlsx(chartTypesPath, { requiredNativeCharts: chartTypeSpecs.map((spec) => ({ sheet: spec.sheet, type: spec.type, minCount: 1, minPoints: 3, sourceRanges: ["A2:A4", "B2:B4", "C2:C4"] })) });
  const detectedTypes = new Set(chartTypesAudit.package.charts.flatMap((chart) => chart.types));
  if (chartTypesAudit.status === "error" || !["line", "column", "bar"].every((type) => detectedTypes.has(type))) throw new Error("Native chart type regression");
  const chartTypesRender = await renderWorkbook(chartTypesPath, path.join(outputDir, "chart-types-render"), { perSheet: true });
  if (chartTypesRender.pageStats.some((page) => page.blank)) throw new Error("A native chart type rendered as a blank page");
  steps.push({ name: "native-chart-types", status: "ok", types: [...detectedTypes], pages: chartTypesRender.pageCount });

  const blankChartPath = path.join(outputDir, "blank-chart-source.xlsx");
  const blankChartWorkbook = createWorkbook();
  blankChartWorkbook.addWorksheet("趋势").addRows([["月份", "数值"], ["1月", 10], [null, null], ["3月", 14]]);
  await blankChartWorkbook.xlsx.writeFile(blankChartPath);
  let blankChartError = null;
  try {
    await injectNativeCharts(blankChartPath, [{
      sheet: "趋势",
      type: "line",
      title: "空值回归",
      minPoints: 3,
      categories: "A2:A4",
      series: [{ name: "数值", values: "B2:B4" }],
      anchor: { from: "D2", to: "K16" },
    }], { JSZip, loadXlsx });
  } catch (error) {
    blankChartError = error;
  }
  if (!(blankChartError instanceof Error) || !blankChartError.message.includes("blank categories")) {
    throw new Error("Native chart injection did not reject blank categories and values");
  }
  steps.push({ name: "native-chart-data-quality", status: "ok", error: blankChartError.message });

  const legacySourceDir = path.join(outputDir, "legacy-source");
  const legacyProfileDir = path.join(outputDir, "legacy-profile");
  await Promise.all([fs.mkdir(legacySourceDir, { recursive: true }), fs.mkdir(legacyProfileDir, { recursive: true })]);
  const legacySeed = path.join(legacySourceDir, "legacy-seed.xlsx");
  const legacySeedWorkbook = createWorkbook();
  legacySeedWorkbook.addWorksheet("旧格式").addRows([["名称", "数值"], ["测试", 42]]);
  await legacySeedWorkbook.xlsx.writeFile(legacySeed);
  await runLibreOffice(["--convert-to", "xls:MS Excel 97", "--outdir", legacySourceDir, legacySeed], legacyProfileDir);
  const legacyXls = path.join(legacySourceDir, "legacy-seed.xls");
  if (!(await pathExists(legacyXls))) throw new Error("Self-test could not create a legacy XLS fixture");
  const legacyConverted = path.join(outputDir, "legacy-converted.xlsx");
  await convertLegacyXls(legacyXls, legacyConverted);
  const legacyWorkbook = await loadXlsx(legacyConverted);
  if (legacyWorkbook.getWorksheet("旧格式")?.getCell("B2").value !== 42) throw new Error("Legacy XLS conversion lost worksheet values");
  steps.push({ name: "xls-conversion", status: "ok" });

  const blankFixture = path.join(outputDir, "blank-page.png");
  await sharp({ create: { width: 320, height: 240, channels: 3, background: "white" } }).png().toFile(blankFixture);
  const blankAnalysis = await analyzeRenderedPage(blankFixture);
  if (!blankAnalysis.blank) throw new Error("Blank-page detection regression");
  steps.push({ name: "blank-page-detection", status: "ok" });

  const rendered = await renderWorkbook(finalPath, path.join(outputDir, "render"), { perSheet: true });
  if (rendered.pageStats.some((page) => page.blank)) throw new Error("Self-test workbook produced an unexpected blank print page");
  steps.push({ name: "render", status: "ok", pageCount: rendered.pageCount, sheets: rendered.sheets.map((sheet) => ({ name: sheet.sheet, pages: sheet.pageCount })), montage: rendered.montage });

  const requirementsPath = path.join(outputDir, "requirements.json");
  const qaReportPath = path.join(outputDir, "visual-review.json");
  const deliveryReportPath = path.join(outputDir, "delivery.json");
  await fs.writeFile(requirementsPath, `${JSON.stringify(selfTestRequirements, null, 2)}\n`, "utf8");
  await writeSpreadsheetAttestation({
    candidatePath: finalPath,
    requirementsPath,
    builderPath: fileURLToPath(import.meta.url),
    requirements: selfTestRequirements,
    audit,
  });
  await commandQaInit({ input: finalPath, requirements: requirementsPath, report: qaReportPath, "render-dir": path.join(outputDir, "qa-render"), quiet: true });
  let qaState = await readJsonFile(qaReportPath, "Self-test visual review");
  const qaObservationsPath = path.join(outputDir, "qa-observations.json");
  await fs.writeFile(qaObservationsPath, `${JSON.stringify({
    reviews: qaState.pages.map((page) => ({
      sheet: page.sheet,
      page: page.page,
      status: "passed",
      notes: `Inspected ${page.id}: content, chart, typography, and page bounds are visible.`,
    })),
  }, null, 2)}\n`, "utf8");
  await commandQaComplete({ report: qaReportPath, reviews: qaObservationsPath, quiet: true });
  await commandDeliver({ input: finalPath, out: sealedPath, requirements: requirementsPath, "qa-report": qaReportPath, report: deliveryReportPath, quiet: true });
  qaState = await readJsonFile(qaReportPath, "Self-test visual review");
  if (qaState.status !== "ok" || await fileSha256(finalPath) !== await fileSha256(sealedPath)) throw new Error("SHA-bound QA and delivery regression");
  steps.push({ name: "qa-delivery-binding", status: "ok", sha256: await fileSha256(sealedPath), pages: qaState.pages.length });

  const attestationBuilderPath = path.join(outputDir, "attestation-builder.mjs");
  await fs.writeFile(attestationBuilderPath, "export default async function build() {}\n", "utf8");
  await writeSpreadsheetAttestation({
    candidatePath: finalPath,
    requirementsPath,
    builderPath: attestationBuilderPath,
    requirements: selfTestRequirements,
    audit,
  });
  await fs.appendFile(attestationBuilderPath, "// changed after build\n");
  let staleBuilderRejected = false;
  try {
    await loadVerifiedSpreadsheetAttestation(attestationPathFor(requirementsPath, finalPath), finalPath, requirementsPath, { includeExternal: true });
  } catch (error) {
    staleBuilderRejected = error instanceof SpreadsheetProtocolError && error.code === "stale-spreadsheet-attestation";
  }
  if (!staleBuilderRejected) throw new Error("Delivery attestation did not reject a builder changed after build");
  steps.push({ name: "attestation-builder-binding", status: "ok", staleBuilderRejected: true });

  const staleCandidatePath = path.join(outputDir, "stale-candidate.xlsx");
  const staleRequirementsPath = path.join(outputDir, "stale-requirements.json");
  const staleQaPath = path.join(outputDir, "stale-visual-review.json");
  await fs.copyFile(finalPath, staleCandidatePath);
  const staleRequirements = structuredClone(selfTestRequirements);
  staleRequirements.task.finalOutput = path.join(outputDir, "stale-final.xlsx");
  staleRequirements.task.visualReview = { mode: "structural-only" };
  await fs.writeFile(staleRequirementsPath, `${JSON.stringify(staleRequirements, null, 2)}\n`, "utf8");
  const staleAudit = await auditXlsx(staleCandidatePath, staleRequirements);
  await writeSpreadsheetAttestation({
    candidatePath: staleCandidatePath,
    requirementsPath: staleRequirementsPath,
    builderPath: fileURLToPath(import.meta.url),
    requirements: staleRequirements,
    audit: staleAudit,
  });
  await commandQaInit({ input: staleCandidatePath, requirements: staleRequirementsPath, report: staleQaPath, quiet: true });
  await fs.appendFile(staleCandidatePath, "changed-after-review");
  let staleQaRejected = false;
  try {
    await commandQaFinalize({ report: staleQaPath, quiet: true });
  } catch (error) {
    staleQaRejected = error instanceof SpreadsheetProtocolError && error.code === "stale-spreadsheet-qa";
  }
  if (!staleQaRejected) throw new Error("QA did not reject a candidate changed after initialization");
  steps.push({ name: "stale-qa-rejection", status: "ok" });

  const workDirBeforeLineage = process.env.PILOTDECK_WORK_DIR;
  const lineageWorkDir = path.join(outputDir, "lineage-session", "turn-work");
  await fs.mkdir(lineageWorkDir, { recursive: true });
  process.env.PILOTDECK_WORK_DIR = lineageWorkDir;
  let lineageResolution;
  try {
    const sealedSha256 = await fileSha256(sealedPath);
    await recordSpreadsheetDelivery(sealedPath, { path: rawPath, sha256: await fileSha256(rawPath) }, sealedSha256);
    lineageResolution = await resolveLatestSpreadsheetInput(rawPath);
  } finally {
    if (workDirBeforeLineage === undefined) delete process.env.PILOTDECK_WORK_DIR;
    else process.env.PILOTDECK_WORK_DIR = workDirBeforeLineage;
  }
  if (!lineageResolution?.tracked || !pathsReferToSameLocation(lineageResolution.resolved, sealedPath)) {
    throw new Error("Spreadsheet lineage did not resolve an original path to the latest delivered version");
  }
  steps.push({ name: "version-lineage", status: "ok", resolved: lineageResolution.resolved });

  const previousWorkDir = process.env.PILOTDECK_WORK_DIR;
  const boundaryRoot = path.join(outputDir, "work-boundary");
  const boundaryOutside = path.join(outputDir, "work-boundary-outside");
  await fs.mkdir(boundaryRoot, { recursive: true });
  await fs.mkdir(boundaryOutside, { recursive: true });
  const boundaryLink = path.join(boundaryRoot, "escape-link");
  await fs.symlink(
    boundaryOutside,
    boundaryLink,
    process.platform === "win32" ? "junction" : "dir",
  );
  process.env.PILOTDECK_WORK_DIR = boundaryRoot;
  let boundaryRejected = false;
  let symlinkBoundaryRejected = false;
  try {
    assertInternalArtifactPath(
      path.join(outputDir, "leaked-inspection.json"),
      "Spreadsheet JSON report",
    );
  } catch (error) {
    boundaryRejected = error instanceof Error
      && error.message.includes("PILOTDECK_WORK_DIR");
  }
  try {
    assertInternalArtifactPath(
      path.join(boundaryLink, "leaked-through-symlink.json"),
      "Spreadsheet JSON report",
    );
  } catch (error) {
    symlinkBoundaryRejected = error instanceof Error
      && error.message.includes("PILOTDECK_WORK_DIR");
  } finally {
    if (previousWorkDir === undefined) delete process.env.PILOTDECK_WORK_DIR;
    else process.env.PILOTDECK_WORK_DIR = previousWorkDir;
  }
  if (!boundaryRejected) throw new Error("Work-directory boundary did not reject a leaked spreadsheet artifact");
  if (!symlinkBoundaryRejected) throw new Error("Work-directory boundary allowed a symlink escape");
  steps.push({ name: "work-directory-boundary", status: "ok" });

  const report = {
    status: "ok",
    outputDir: path.resolve(outputDir),
    workbook: path.resolve(finalPath),
    render: rendered,
    steps,
  };
  await writeJson(path.join(outputDir, "self-test-report.json"), report);
  await emitReport(report);
}

function printHelp() {
  process.stdout.write(`PilotDeck spreadsheets skill\n\nNormal workflow:\n  capabilities [--feature charts|numericIntegrity] [--full]\n  schema --command <prepare|requirements|status|qa-complete|numeric-integrity|native-chart|image|fallback-patch>\n  prepare --final-out final.xlsx [--input source.xlsx] [--source facts.xlsx] [--data-operation create|presentation-only|copy|union|transform|ocr] [--validation-profile fast|standard|strict]\n  status --requirements requirements.json\n  scaffold --out builder.mjs\n  build --builder builder.mjs --out candidate.xlsx [--input source.xlsx] --requirements requirements.json\n  qa-init --input candidate.xlsx --requirements requirements.json --report visual-review.json\n  qa-complete --report visual-review.json --reviews observations.json\n  deliver --input candidate.xlsx --out final.xlsx --requirements requirements.json --qa-report visual-review.json\n\nInspection and compatibility:\n  resolve-latest --input source.xlsx [--use-exact-input]\n  inspect --input book.xlsx [--sheet Sheet1 --range A1:H20 --styles --out report.json]\n  convert-legacy --input source.xls --out converted.xlsx\n  recalculate --input source.xlsx --out recalculated.xlsx\n  render --input book.xlsx --out-dir render [--pdf render.pdf --montage montage.png --per-sheet]\n  fallback-patch --input candidate.xlsx --script patch.mjs --out patched.xlsx --manifest fallback.json --reason TEXT --allow-part PART\n\nLegacy/debug validation:\n  audit --input book.xlsx [--requirements requirements.json --out audit.json]\n  integrity-scaffold --requirements requirements.json --operation <copy|union|join|aggregate|formula|ocr>\n  integrity-status --requirements requirements.json\n  integrity-bind --requirements requirements.json [--plan integrity-plan.json --evidence source-evidence.json]\n  qa-record --report visual-review.json --sheet Sheet1 --page 1 --status passed --notes TEXT\n  qa-finalize --report visual-review.json\n  self-test [--out directory]\n`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "capabilities": await commandCapabilities(options); break;
    case "schema": await commandSchema(options); break;
    case "prepare": await commandPrepare(options); break;
    case "status": await commandTaskStatus(options); break;
    case "evidence-observe": await commandEvidenceObserve(options); break;
    case "evidence-confirm": await commandEvidenceConfirm(options); break;
    case "integrity-scaffold": await commandIntegrityScaffold(options); break;
    case "integrity-status": await commandIntegrityStatus(options); break;
    case "integrity-bind": await commandIntegrityBind(options); break;
    case "resolve-latest": await commandResolveLatest(options); break;
    case "scaffold": await commandScaffold(options); break;
    case "build": await commandBuild(options); break;
    case "fallback-patch": await commandFallbackPatch(options); break;
    case "inspect": await commandInspect(options); break;
    case "convert-legacy": await commandConvertLegacy(options); break;
    case "recalculate": await commandRecalculate(options); break;
    case "audit": await commandAudit(options); break;
    case "render": await commandRender(options); break;
    case "qa-init": await commandQaInit(options); break;
    case "qa-record": await commandQaRecord(options); break;
    case "qa-complete": await commandQaComplete(options); break;
    case "qa-finalize": await commandQaFinalize(options); break;
    case "deliver": await commandDeliver(options); break;
    case "self-test": await commandSelfTest(options); break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    default:
      throw new Error(`Unknown command '${command}'. Run with --help.`);
  }
}

main().catch((error) => {
  const protocolError = error instanceof SpreadsheetProtocolError
    ? error
    : error instanceof SpreadsheetStageError && error.cause instanceof SpreadsheetProtocolError
      ? error.cause
      : null;
  const payload = {
    status: protocolError?.status ?? "error",
    ...(protocolError?.code ? { code: protocolError.code } : {}),
    ...(protocolError?.details && Object.keys(protocolError.details).length > 0 ? { details: protocolError.details } : {}),
    ...(!protocolError && error instanceof SpreadsheetStageError && Object.keys(error.details ?? {}).length > 0 ? { details: error.details } : {}),
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof SpreadsheetStageError ? { stage: error.stage } : {}),
    ...(error instanceof Error && error.cause instanceof Error ? { cause: error.cause.message } : {}),
    ...(error instanceof Error && error.cause instanceof Error && error.cause.stack ? { causeStack: error.cause.stack.split("\n").slice(0, 12) } : {}),
    ...(error instanceof Error && error.stack ? { stack: error.stack.split("\n").slice(0, 8) } : {}),
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});
