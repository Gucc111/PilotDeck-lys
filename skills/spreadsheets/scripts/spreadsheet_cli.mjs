#!/usr/bin/env node

import fs from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const runtimeRoot = process.env.SPREADSHEET_RUNTIME_ROOT;

if (!runtimeRoot) {
  throw new Error("SPREADSHEET_RUNTIME_ROOT is not set. Run this command through scripts/spreadsheet.sh.");
}

const require = createRequire(path.join(runtimeRoot, "package.json"));
const ExcelJS = require("exceljs");
const { parse: parseDelimitedText } = require("csv-parse/sync");
const JSZip = require("jszip");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const iconv = require("iconv-lite");

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

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
    if (value !== true) index += 1;
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

function resolveThroughExistingAncestor(filePath) {
  let current = path.resolve(filePath);
  const suffix = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const base = existsSync(current) ? realpathSync.native(current) : current;
  return path.resolve(base, ...suffix);
}

function pilotDeckWorkDir() {
  const configured = String(process.env.PILOTDECK_WORK_DIR ?? "").trim();
  return configured ? resolveThroughExistingAncestor(configured) : null;
}

function isInsidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsReferToSameLocation(left, right) {
  return resolveThroughExistingAncestor(left) === resolveThroughExistingAncestor(right);
}

function assertDistinctPaths(entries) {
  const paths = Object.entries(entries)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([name, value]) => [name, path.resolve(String(value))]);
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (!pathsReferToSameLocation(paths[left][1], paths[right][1])) continue;
      throw blocked("artifact-path-conflict", `Spreadsheet ${paths[left][0]} and ${paths[right][0]} must use distinct paths`, {
        [paths[left][0]]: paths[left][1],
        [paths[right][0]]: paths[right][1],
      });
    }
  }
}

function assertInternalPath(filePath, purpose) {
  const resolved = resolveThroughExistingAncestor(filePath);
  const workDir = pilotDeckWorkDir();
  if (workDir && !isInsidePath(resolved, workDir)) {
    throw new Error(`${purpose} must be under PILOTDECK_WORK_DIR (${workDir})`);
  }
  return resolved;
}

function assertDeliveryPath(filePath) {
  const resolved = resolveThroughExistingAncestor(filePath);
  const workDir = pilotDeckWorkDir();
  if (workDir && isInsidePath(resolved, workDir)) {
    throw new Error("The final spreadsheet deliverable must be outside PILOTDECK_WORK_DIR");
  }
  return resolved;
}

function workbookExtension(filePath) {
  return path.extname(filePath).toLowerCase();
}

function assertSupportedInput(filePath, { legacy = false } = {}) {
  const extension = workbookExtension(filePath);
  const allowed = legacy ? [".xlsx", ".xls", ".csv", ".tsv"] : [".xlsx", ".csv", ".tsv"];
  if (!allowed.includes(extension)) throw new Error(`Unsupported spreadsheet format '${extension || "(none)"}'. Use ${allowed.join(", ")}.`);
  return extension;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function atomicWriteBuffer(filePath, buffer) {
  const resolved = path.resolve(filePath);
  await ensureParent(resolved);
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporary, buffer);
  try {
    await fs.rename(temporary, resolved);
  } catch (error) {
    if (!await pathExists(resolved)) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    const backup = `${resolved}.${process.pid}.${Date.now()}.bak`;
    await fs.rename(resolved, backup);
    try {
      await fs.rename(temporary, resolved);
      await fs.rm(backup, { force: true });
    } catch (replaceError) {
      if (await pathExists(backup)) await fs.rename(backup, resolved);
      await fs.rm(temporary, { force: true });
      throw replaceError;
    }
  }
}

async function writeJson(filePath, value) {
  const target = assertInternalPath(filePath, "Spreadsheet JSON report");
  await atomicWriteBuffer(target, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

async function emitReport(report, filePath = null) {
  if (filePath) await writeJson(filePath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function serializable(value, seen = new WeakSet()) {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (Buffer.isBuffer(value)) return { bytes: value.length };
  if (Array.isArray(value)) return value.map((item) => serializable(item, seen));
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "function") continue;
      result[key] = serializable(item, seen);
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

function localName(node) {
  return node?.localName ?? node?.nodeName?.split(":").at(-1) ?? null;
}

function elementsByLocalName(root, name) {
  const matches = [];
  const elements = root.getElementsByTagName("*");
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements.item(index);
    if (localName(element) === name) matches.push(element);
  }
  return matches;
}

function directChild(element, name) {
  for (let child = element?.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && localName(child) === name) return child;
  }
  return null;
}

function parseXml(xml, partName = "XML") {
  const diagnostics = [];
  const document = new DOMParser({
    onError(level, message) {
      diagnostics.push({ level, message });
    },
  }).parseFromString(xml, "application/xml");
  const failures = diagnostics.filter((item) => item.level === "error" || item.level === "fatalError");
  if (!document?.documentElement || failures.length > 0 || elementsByLocalName(document, "parsererror").length > 0) {
    throw new Error(`Malformed XML in ${partName}: ${failures.map((item) => item.message).join("; ") || "parser error"}`);
  }
  return document;
}

function serializeXml(document) {
  return new XMLSerializer().serializeToString(document);
}

function expectedRoot(entryName) {
  if (entryName === "[Content_Types].xml") return "Types";
  if (entryName.endsWith(".rels")) return "Relationships";
  if (entryName === "xl/workbook.xml") return "workbook";
  if (/^xl\/worksheets\/[^/]+\.xml$/i.test(entryName)) return "worksheet";
  if (entryName === "xl/styles.xml") return "styleSheet";
  if (entryName === "xl/sharedStrings.xml") return "sst";
  return null;
}

async function loadPackage(filePath) {
  const buffer = await fs.readFile(filePath);
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    throw new Error(`Invalid XLSX ZIP package: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const required of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"]) {
    if (!zip.file(required)) throw new Error(`The XLSX package is missing ${required}`);
  }
  return { buffer, zip };
}

function resolveRelationshipTarget(ownerPart, target) {
  const decoded = String(target ?? "").replaceAll("\\", "/");
  const resolved = decoded.startsWith("/")
    ? path.posix.normalize(decoded.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(ownerPart), decoded));
  if (!resolved || resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) {
    throw new Error(`Unsafe package relationship target '${target}' from ${ownerPart}`);
  }
  return resolved;
}

async function workbookSheets(zip) {
  const workbookXml = await zip.file("xl/workbook.xml").async("string");
  const relationshipsXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const workbookDocument = parseXml(workbookXml, "xl/workbook.xml");
  const relationshipsDocument = parseXml(relationshipsXml, "xl/_rels/workbook.xml.rels");
  const relationships = new Map();
  for (const relationship of elementsByLocalName(relationshipsDocument, "Relationship")) {
    if (String(relationship.getAttribute("TargetMode") ?? "").toLowerCase() === "external") continue;
    const id = relationship.getAttribute("Id");
    const target = relationship.getAttribute("Target");
    if (id && target) relationships.set(id, resolveRelationshipTarget("xl/workbook.xml", target));
  }
  return elementsByLocalName(workbookDocument, "sheet").map((sheet, index) => {
    const relationshipId = sheet.getAttributeNS?.(REL_NS, "id") || sheet.getAttribute("r:id");
    const part = relationships.get(relationshipId);
    if (!part || !zip.file(part)) throw new Error(`Worksheet relationship '${relationshipId}' cannot be resolved`);
    return {
      index,
      name: sheet.getAttribute("name") ?? `Sheet${index + 1}`,
      state: sheet.getAttribute("state") ?? "visible",
      relationshipId,
      part,
    };
  });
}

async function validatePackageXml(zip) {
  const issues = [];
  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir || !/\.(?:xml|rels)$/i.test(entryName)) continue;
    try {
      const document = parseXml(await entry.async("string"), entryName);
      const wanted = expectedRoot(entryName);
      if (wanted && localName(document.documentElement) !== wanted) {
        issues.push({ type: "unexpected_xml_root", part: entryName, expected: wanted, actual: localName(document.documentElement) });
      }
    } catch (error) {
      issues.push({ type: "malformed_xml", part: entryName, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (issues.length > 0) throw new Error(`Invalid XLSX package XML: ${JSON.stringify(issues.slice(0, 8))}`);
}

function formulaKey(record) {
  return `${record.sheet}!${record.address}`;
}

async function collectFormulaRecords(zip, sheets = null) {
  const records = [];
  const worksheetList = sheets ?? await workbookSheets(zip);
  for (const sheet of worksheetList) {
    const document = parseXml(await zip.file(sheet.part).async("string"), sheet.part);
    for (const cell of elementsByLocalName(document, "c")) {
      const formula = directChild(cell, "f");
      if (!formula) continue;
      const value = directChild(cell, "v");
      const cellType = cell.getAttribute("t") || null;
      const cachedText = value?.textContent ?? null;
      records.push({
        sheet: sheet.name,
        sheetPart: sheet.part,
        address: cell.getAttribute("r"),
        formula: formula.textContent ?? "",
        formulaType: formula.getAttribute("t") || null,
        sharedIndex: formula.getAttribute("si") || null,
        formulaRef: formula.getAttribute("ref") || null,
        cellType,
        hasCache: Boolean(value) && (cachedText !== "" || cellType === "str"),
        cachedValue: cachedText,
      });
    }
  }
  return records;
}

async function worksheetFacts(zip, sheets = null) {
  const result = [];
  for (const sheet of sheets ?? await workbookSheets(zip)) {
    const document = parseXml(await zip.file(sheet.part).async("string"), sheet.part);
    result.push({
      name: sheet.name,
      state: sheet.state,
      part: sheet.part,
      dimension: elementsByLocalName(document, "dimension")[0]?.getAttribute("ref") ?? null,
      merges: elementsByLocalName(document, "mergeCell").map((item) => item.getAttribute("ref")).filter(Boolean),
      conditionalFormatting: elementsByLocalName(document, "conditionalFormatting").map((item) => item.getAttribute("sqref")).filter(Boolean),
      dataValidations: elementsByLocalName(document, "dataValidation").map((item) => item.getAttribute("sqref")).filter(Boolean),
      tables: elementsByLocalName(document, "tablePart").length,
      formulas: elementsByLocalName(document, "f").length,
    });
  }
  return result;
}

function countEntries(entries, expression) {
  return entries.filter((entry) => expression.test(entry)).length;
}

async function packageFacts(zip) {
  const entries = Object.keys(zip.files).filter((entry) => !zip.files[entry].dir);
  const sheets = await workbookSheets(zip);
  const sheetDetails = await worksheetFacts(zip, sheets);
  return {
    entryCount: entries.length,
    worksheets: sheetDetails,
    features: {
      macros: countEntries(entries, /(?:^|\/)vbaProject\.bin$/i),
      charts: countEntries(entries, /^xl\/charts\/[^/]+\.xml$/i),
      drawings: countEntries(entries, /^xl\/drawings\/drawing[^/]+\.xml$/i),
      pivotParts: countEntries(entries, /^xl\/(?:pivotTables|pivotCache)\//i),
      slicers: countEntries(entries, /^xl\/(?:slicers|slicerCaches)\//i),
      externalLinks: countEntries(entries, /^xl\/externalLinks\//i),
      connections: countEntries(entries, /^xl\/connections\.xml$/i),
      queryTables: countEntries(entries, /^xl\/queryTables\//i),
      tables: countEntries(entries, /^xl\/tables\/[^/]+\.xml$/i),
      media: countEntries(entries, /^xl\/media\//i),
      embeddings: countEntries(entries, /^xl\/embeddings\//i),
      activeX: countEntries(entries, /^xl\/activeX\//i),
      comments: countEntries(entries, /^xl\/(?:comments|threadedComments)\//i) + countEntries(entries, /^xl\/comments[^/]+\.xml$/i),
      customXml: countEntries(entries, /^customXml\//i),
      signatures: countEntries(entries, /^_xmlsignatures\//i),
      conditionalFormatting: sheetDetails.reduce((sum, sheet) => sum + sheet.conditionalFormatting.length, 0),
      dataValidations: sheetDetails.reduce((sum, sheet) => sum + sheet.dataValidations.length, 0),
    },
  };
}

function cachedValue(record) {
  if (!record.hasCache) return null;
  const text = record.cachedValue ?? "";
  const type = String(record.cellType ?? "n").toLowerCase();
  if (type === "b") return text !== "0";
  if (type === "e") return { error: text };
  if (type === "str" || type === "inlinestr" || type === "d") return text;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : text;
}

function effectiveFormulaResultType(type) {
  return !type || type === "n" ? "n" : type;
}

function formulaCompatibilityIssues(records) {
  const issues = new Map();
  const unsafeSharedGroups = new Map();
  for (const record of records) {
    let reason = null;
    if (["array", "dataTable"].includes(record.formulaType)) reason = `${record.formulaType}_formula`;
    else if (/(?:_xlfn\.|_xlws\.|_xludf\.)/i.test(record.formula)) reason = "excel_extension_formula";
    else if (/\[[^\]]+\][^!]*!/i.test(record.formula)) reason = "external_workbook_reference";
    else if (/\bCUBE[A-Z0-9_.]*\s*\(/i.test(record.formula)) reason = "data_model_formula";
    else if (/[A-Z]{1,3}[0-9]+#/i.test(record.formula)) reason = "dynamic_array_spill";
    if (reason) {
      issues.set(formulaKey(record), reason);
      if (record.formulaType === "shared" && record.sharedIndex !== null) {
        unsafeSharedGroups.set(`${record.sheet}:${record.sharedIndex}`, reason);
      }
    }
  }
  for (const record of records) {
    if (record.formulaType !== "shared" || record.sharedIndex === null) continue;
    const reason = unsafeSharedGroups.get(`${record.sheet}:${record.sharedIndex}`);
    if (reason) issues.set(formulaKey(record), reason);
  }
  return issues;
}

function formulaReport(records, maxItems = 100) {
  const compatibility = formulaCompatibilityIssues(records);
  const missingCachedResults = records.filter((record) => !record.hasCache);
  const errors = records.filter((record) => String(record.cellType ?? "").toLowerCase() === "e");
  const invalidReferences = records.filter((record) => /#REF!/i.test(record.formula));
  return {
    count: records.length,
    items: records.slice(0, maxItems).map((record) => ({
      sheet: record.sheet,
      address: record.address,
      formula: record.formula,
      formulaType: record.formulaType,
      value: cachedValue(record),
      cachePresent: record.hasCache,
    })),
    missingCachedResults: missingCachedResults.slice(0, 100).map((record) => ({ sheet: record.sheet, address: record.address, formula: record.formula })),
    errors: errors.slice(0, 100).map((record) => ({ sheet: record.sheet, address: record.address, error: record.cachedValue })),
    invalidReferences: invalidReferences.slice(0, 100).map((record) => ({ sheet: record.sheet, address: record.address, formula: record.formula })),
    compatibilityRisks: [...compatibility.entries()].slice(0, 100).map(([key, reason]) => ({ key, reason })),
  };
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function relationshipOwnerPart(relationshipPart) {
  const match = /^(.*\/)?_rels\/([^/]+)\.rels$/i.exec(relationshipPart);
  if (!match) return null;
  return `${match[1] ?? ""}${match[2]}`;
}

async function normalizeForExcelJs(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  let changed = false;
  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir || !entryName.endsWith(".xml")) continue;
    let xml = await entry.async("string");
    const namespaceMatch = xml.match(/xmlns:([A-Za-z_][\w.-]*)=(["'])http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main\2/);
    if (namespaceMatch) {
      const prefix = escapeRegularExpression(namespaceMatch[1]);
      const quote = namespaceMatch[2];
      const defaultNamespace = `xmlns=${quote}${MAIN_NS}${quote}`;
      xml = xml.replace(new RegExp(`(<\\/?)(?:${prefix}):`, "g"), "$1");
      xml = xml.includes(defaultNamespace) ? xml.replace(namespaceMatch[0], "") : xml.replace(namespaceMatch[0], defaultNamespace);
    }
    if (xml !== await entry.async("string")) {
      zip.file(entryName, xml);
      changed = true;
    }
  }
  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir || !entryName.endsWith(".rels")) continue;
    const owner = relationshipOwnerPart(entryName);
    if (!owner) continue;
    const xml = await entry.async("string");
    const normalized = xml.replace(/(<Relationship\b[^>]*\bTarget=)(["'])(\/[^"']+)\2/gi, (_match, before, quote, target) => {
      const relative = path.posix.relative(path.posix.dirname(owner), target.slice(1));
      return `${before}${quote}${relative}${quote}`;
    });
    if (normalized !== xml) {
      zip.file(entryName, normalized);
      changed = true;
    }
  }
  return changed ? zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) : buffer;
}

async function loadXlsx(filePath, formulaRecords = null) {
  const source = await fs.readFile(filePath);
  let workbook = new ExcelJS.Workbook();
  let normalized = false;
  try {
    await workbook.xlsx.load(source);
  } catch (firstError) {
    const fallback = await normalizeForExcelJs(source);
    workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(fallback);
      normalized = fallback !== source;
    } catch {
      throw firstError;
    }
  }
  const records = formulaRecords ?? collectFormulaRecords((await loadPackage(filePath)).zip);
  for (const record of await records) {
    const worksheet = workbook.getWorksheet(record.sheet);
    if (!worksheet || !record.address || !record.hasCache) continue;
    const cell = worksheet.getCell(record.address);
    const value = cell.value;
    if (!value || typeof value !== "object" || !("formula" in value || "sharedFormula" in value)) continue;
    if (Object.hasOwn(value, "result") && value.result !== null && value.result !== undefined) continue;
    cell.value = { ...value, result: cachedValue(record) };
  }
  return { workbook, normalized };
}

function columnNumber(letters) {
  let result = 0;
  for (const character of letters.toUpperCase()) result = result * 26 + character.charCodeAt(0) - 64;
  return result;
}

function columnLetters(number) {
  let value = number;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function parseRange(range) {
  const match = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(String(range).trim());
  if (!match) throw new Error(`Invalid cell range '${range}'`);
  return {
    startCol: columnNumber(match[1]),
    startRow: Number(match[2]),
    endCol: columnNumber(match[3] ?? match[1]),
    endRow: Number(match[4] ?? match[2]),
  };
}

function cellStyle(cell) {
  return serializable({
    numberFormat: cell.numFmt ?? null,
    font: cell.font ? { name: cell.font.name, size: cell.font.size, bold: cell.font.bold, italic: cell.font.italic, color: cell.font.color } : null,
    fill: cell.fill ?? null,
    alignment: cell.alignment ?? null,
    border: cell.border ?? null,
  });
}

function cellFormula(cell) {
  const value = cell.value;
  if (!value || typeof value !== "object" || !("formula" in value || "sharedFormula" in value)) return null;
  return { formula: value.formula ?? null, sharedFormula: value.sharedFormula ?? null, result: value.result ?? null };
}

function inspectSelection(worksheet, requestedRange, maxRows, maxCols, styles, formulaRecords = new Map()) {
  const usedRows = Math.max(worksheet.rowCount, worksheet.actualRowCount, 1);
  const usedCols = Math.max(worksheet.columnCount, worksheet.actualColumnCount, 1);
  const requested = requestedRange ? parseRange(requestedRange) : { startRow: 1, startCol: 1, endRow: usedRows, endCol: usedCols };
  const range = {
    ...requested,
    endRow: Math.min(requested.endRow, requested.startRow + maxRows - 1),
    endCol: Math.min(requested.endCol, requested.startCol + maxCols - 1),
  };
  const cells = [];
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    for (let column = range.startCol; column <= range.endCol; column += 1) {
      const cell = worksheet.getCell(row, column);
      const packageFormula = formulaRecords.get(`${worksheet.name}!${cell.address}`);
      const formula = packageFormula ? {
        formula: packageFormula.formula,
        sharedFormula: packageFormula.formulaType === "shared" && !packageFormula.formula
          ? { sharedIndex: packageFormula.sharedIndex }
          : null,
        result: cachedValue(packageFormula),
      } : cellFormula(cell);
      if (cell.value === null && !formula && !(styles && cell.hasStyle)) continue;
      const item = {
        address: cell.address,
        value: serializable(formula ? formula.result : cell.value),
      };
      if (formula) item.formula = formula.formula ?? { sharedFormula: formula.sharedFormula };
      if (styles) item.style = cellStyle(cell);
      cells.push(item);
    }
  }
  return {
    range: `${columnLetters(range.startCol)}${range.startRow}:${columnLetters(range.endCol)}${range.endRow}`,
    truncated: !requestedRange && (usedRows > maxRows || usedCols > maxCols),
    cells,
  };
}

function decodeDelimited(buffer, requested = "auto") {
  const normalized = String(requested).toLowerCase().replaceAll("_", "-");
  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  let encoding = normalized;
  if (encoding === "auto") {
    if (hasBom) encoding = "utf-8-bom";
    else {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        encoding = "utf-8";
      } catch {
        encoding = "gb18030";
      }
    }
  }
  if (!["utf8", "utf-8", "utf8-bom", "utf-8-bom", "gbk", "gb18030"].includes(encoding)) {
    throw new Error(`Unsupported text encoding '${requested}'`);
  }
  const text = encoding.startsWith("utf")
    ? buffer.subarray(hasBom ? 3 : 0).toString("utf8")
    : iconv.decode(buffer, encoding === "gbk" ? "gbk" : "gb18030");
  return { text, encoding };
}

async function inspectDelimited(filePath, options = {}) {
  const extension = assertSupportedInput(filePath);
  const delimiter = extension === ".tsv" ? "\t" : ",";
  const decoded = decodeDelimited(await fs.readFile(filePath), options.encoding ?? "auto");
  const rows = parseDelimitedText(decoded.text, { bom: true, delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: false });
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
    maxColumnCount: Math.max(0, ...widths),
    inconsistentRowWidths: new Set(widths).size > 1,
    rows: rows.slice(0, maxRows).map((row) => row.slice(0, maxCols)),
    truncated: rows.length > maxRows || widths.some((width) => width > maxCols),
  };
}

async function inspectXlsx(filePath, options = {}) {
  const { zip } = await loadPackage(filePath);
  await validatePackageXml(zip);
  const sheets = await workbookSheets(zip);
  const records = await collectFormulaRecords(zip, sheets);
  const facts = await packageFacts(zip);
  const report = {
    status: "ok",
    path: path.resolve(filePath),
    format: "xlsx",
    workbook: { worksheetCount: sheets.length, worksheets: facts.worksheets },
    package: { entryCount: facts.entryCount, features: facts.features },
    formulas: formulaReport(records, integerOption(options, "max-formulas", 100)),
  };
  try {
    const { workbook, normalized } = await loadXlsx(filePath, Promise.resolve(records));
    const worksheet = options.sheet ? workbook.getWorksheet(String(options.sheet)) : workbook.worksheets[0];
    if (!worksheet) throw new Error(options.sheet ? `Worksheet '${options.sheet}' was not found` : "Workbook has no worksheets");
    report.readerNormalization = normalized;
    report.selection = {
      sheet: worksheet.name,
      ...inspectSelection(
        worksheet,
        options.range ? String(options.range) : null,
        integerOption(options, "max-rows", 30),
        integerOption(options, "max-cols", 20),
        Boolean(options.styles),
        new Map(records.map((record) => [formulaKey(record), record])),
      ),
    };
  } catch (error) {
    report.status = "partial";
    report.selection = null;
    report.readerIssue = error instanceof Error ? error.message : String(error);
  }
  return report;
}

function findSoffice() {
  const configured = String(process.env.SPREADSHEET_SKILL_SOFFICE ?? "").trim();
  if (configured) return configured;
  if (process.platform === "darwin") return "/Applications/LibreOffice.app/Contents/MacOS/soffice";
  return "soffice";
}

function findRenderer() {
  return String(process.env.SPREADSHEET_SKILL_PDF_RENDERER ?? "").trim();
}

async function runLibreOffice(args, profileDir) {
  const soffice = findSoffice();
  if (!soffice || (path.isAbsolute(soffice) && !await pathExists(soffice))) {
    throw unsupported("libreoffice-unavailable", "LibreOffice was not found");
  }
  const fontDirectories = [
    "/System/Library/Fonts",
    "/System/Library/Fonts/Supplemental",
    "/Library/Fonts",
    path.join(os.homedir(), "Library", "Fonts"),
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    process.env.WINDIR ? path.join(process.env.WINDIR, "Fonts") : "C:/Windows/Fonts",
  ];
  const available = [];
  for (const directory of fontDirectories) if (await pathExists(directory)) available.push(directory);
  const cache = path.join(profileDir, "font-cache");
  await fs.mkdir(cache, { recursive: true });
  const escapeXml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const fontConfig = path.join(profileDir, "fonts.conf");
  await fs.writeFile(fontConfig, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>${available.map((directory) => `<dir>${escapeXml(directory)}</dir>`).join("")}<cachedir>${escapeXml(cache)}</cachedir></fontconfig>`, "utf8");
  const profile = `-env:UserInstallation=${pathToFileURL(profileDir).href}`;
  try {
    const result = await execFileAsync(soffice, [profile, "--headless", "--nologo", "--nodefault", "--nofirststartwizard", "--norestore", ...args], {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, FONTCONFIG_FILE: fontConfig },
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error?.code === "ENOENT") throw unsupported("libreoffice-unavailable", "LibreOffice was not found");
    throw error;
  }
}

function createMainElement(document, reference, name) {
  const prefix = reference?.prefix ? `${reference.prefix}:` : "";
  return document.createElementNS(MAIN_NS, `${prefix}${name}`);
}

async function prepareCalculationCopy(inputBuffer, outputPath) {
  const zip = await JSZip.loadAsync(inputBuffer);
  const workbookPart = zip.file("xl/workbook.xml");
  const workbookDocument = parseXml(await workbookPart.async("string"), "xl/workbook.xml");
  let calculation = elementsByLocalName(workbookDocument, "calcPr")[0];
  if (!calculation) {
    calculation = createMainElement(workbookDocument, workbookDocument.documentElement, "calcPr");
    const extensions = elementsByLocalName(workbookDocument, "extLst")[0];
    workbookDocument.documentElement.insertBefore(calculation, extensions ?? null);
  }
  calculation.setAttribute("calcMode", "auto");
  calculation.setAttribute("fullCalcOnLoad", "1");
  calculation.setAttribute("forceFullCalc", "1");
  zip.file("xl/workbook.xml", serializeXml(workbookDocument));

  for (const sheet of await workbookSheets(zip)) {
    const document = parseXml(await zip.file(sheet.part).async("string"), sheet.part);
    let changed = false;
    for (const cell of elementsByLocalName(document, "c")) {
      const formula = directChild(cell, "f");
      if (!formula) continue;
      if ((formula.textContent ?? "").startsWith("=")) formula.textContent = formula.textContent.slice(1);
      const value = directChild(cell, "v");
      if (value) cell.removeChild(value);
      changed = true;
    }
    if (changed) zip.file(sheet.part, serializeXml(document));
  }
  await fs.writeFile(outputPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

function cacheAgnosticFingerprint(xml, partName) {
  const document = parseXml(xml, partName);
  for (const cell of elementsByLocalName(document, "c")) {
    if (!directChild(cell, "f")) continue;
    cell.removeAttribute("t");
    const value = directChild(cell, "v");
    if (value) cell.removeChild(value);
  }
  return sha256(Buffer.from(serializeXml(document), "utf8"));
}

function applyCacheUpdates(xml, partName, updates) {
  const before = cacheAgnosticFingerprint(xml, partName);
  const document = parseXml(xml, partName);
  const cells = new Map(elementsByLocalName(document, "c").map((cell) => [cell.getAttribute("r"), cell]));
  for (const update of updates) {
    const cell = cells.get(update.address);
    if (!cell || !directChild(cell, "f")) throw new Error(`Formula cell ${update.address} disappeared from ${partName}`);
    if (!update.cellType || update.cellType === "n") cell.removeAttribute("t");
    else cell.setAttribute("t", update.cellType);
    let value = directChild(cell, "v");
    if (!value) {
      value = createMainElement(document, cell, "v");
      const formula = directChild(cell, "f");
      cell.insertBefore(value, formula.nextSibling);
    }
    value.textContent = update.cachedValue ?? "";
  }
  const output = serializeXml(document);
  const after = cacheAgnosticFingerprint(output, partName);
  if (before !== after) throw new Error(`Non-cache worksheet content changed while updating ${partName}`);
  return output;
}

async function packagePayloadHashes(zip) {
  const result = new Map();
  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    result.set(entryName, sha256(await entry.async("nodebuffer")));
  }
  return result;
}

function diffHashMaps(before, after) {
  const beforeNames = new Set(before.keys());
  const afterNames = new Set(after.keys());
  return {
    added: [...afterNames].filter((name) => !beforeNames.has(name)).sort(),
    removed: [...beforeNames].filter((name) => !afterNames.has(name)).sort(),
    changed: [...beforeNames].filter((name) => afterNames.has(name) && before.get(name) !== after.get(name)).sort(),
    unchanged: [...beforeNames].filter((name) => after.get(name) === before.get(name)).length,
  };
}

async function recalculatePreservingPackage(inputPath, outputPath) {
  const { buffer: originalBuffer, zip: originalZip } = await loadPackage(inputPath);
  await validatePackageXml(originalZip);
  const originalSheets = await workbookSheets(originalZip);
  const originalRecords = await collectFormulaRecords(originalZip, originalSheets);
  if (originalRecords.length === 0) {
    await atomicWriteBuffer(outputPath, originalBuffer);
    return {
      status: "ok",
      outcome: "skipped_no_formulas",
      input: path.resolve(inputPath),
      output: path.resolve(outputPath),
      formulas: { total: 0, updated: 0, preserved: 0 },
      package: { changedParts: [], unchangedParts: Object.keys(originalZip.files).filter((name) => !originalZip.files[name].dir).length },
    };
  }

  const compatibility = formulaCompatibilityIssues(originalRecords);
  if (compatibility.size === originalRecords.length) {
    return {
      status: "unsupported",
      outcome: "no_supported_formulas",
      input: path.resolve(inputPath),
      output: null,
      formulas: {
        total: originalRecords.length,
        updated: 0,
        preserved: originalRecords.length,
        skipped: originalRecords.slice(0, 100).map((record) => ({
          sheet: record.sheet,
          address: record.address,
          reason: compatibility.get(formulaKey(record)),
        })),
      },
    };
  }
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-recalc-"));
  try {
    const sourceDir = path.join(tempRoot, "source");
    const convertedDir = path.join(tempRoot, "converted");
    const profileDir = path.join(tempRoot, "profile");
    await Promise.all([fs.mkdir(sourceDir, { recursive: true }), fs.mkdir(convertedDir, { recursive: true }), fs.mkdir(profileDir, { recursive: true })]);
    const sourcePath = path.join(sourceDir, "workbook.xlsx");
    await prepareCalculationCopy(originalBuffer, sourcePath);
    const conversion = await runLibreOffice(["--convert-to", "xlsx:Calc MS Excel 2007 XML", "--outdir", convertedDir, sourcePath], profileDir);
    const calculatedPath = path.join(convertedDir, "workbook.xlsx");
    if (!await pathExists(calculatedPath)) {
      throw new Error(`LibreOffice did not produce a recalculated XLSX. ${conversion.stderr || conversion.stdout}`.trim());
    }
    const { zip: calculatedZip } = await loadPackage(calculatedPath);
    const calculatedRecords = await collectFormulaRecords(calculatedZip);
    const calculatedMap = new Map(calculatedRecords.map((record) => [formulaKey(record), record]));
    const updatesByPart = new Map();
    const skipped = [];
    let verified = 0;

    for (const record of originalRecords) {
      const key = formulaKey(record);
      const knownIssue = compatibility.get(key);
      if (knownIssue) {
        skipped.push({ sheet: record.sheet, address: record.address, reason: knownIssue });
        continue;
      }
      const calculated = calculatedMap.get(key);
      if (!calculated || !calculated.hasCache) {
        skipped.push({ sheet: record.sheet, address: record.address, reason: "calculation_result_missing" });
        continue;
      }
      if (["s", "inlineStr"].includes(calculated.cellType)) {
        skipped.push({ sheet: record.sheet, address: record.address, reason: "unsafe_shared_string_result" });
        continue;
      }
      if (calculated.cellType === "e" && /^#NAME\?/i.test(calculated.cachedValue ?? "")) {
        skipped.push({ sheet: record.sheet, address: record.address, reason: "calculation_engine_name_error" });
        continue;
      }
      if (
        record.hasCache
        && record.cachedValue === calculated.cachedValue
        && effectiveFormulaResultType(record.cellType) === effectiveFormulaResultType(calculated.cellType)
      ) {
        verified += 1;
        continue;
      }
      const updates = updatesByPart.get(record.sheetPart) ?? [];
      updates.push({
        address: record.address,
        cellType: effectiveFormulaResultType(calculated.cellType) === "n" ? record.cellType : calculated.cellType,
        cachedValue: calculated.cachedValue,
      });
      updatesByPart.set(record.sheetPart, updates);
    }

    const outputZip = await JSZip.loadAsync(originalBuffer);
    for (const [partName, updates] of updatesByPart.entries()) {
      const originalXml = await outputZip.file(partName).async("string");
      outputZip.file(partName, applyCacheUpdates(originalXml, partName, updates));
    }
    const outputBuffer = await outputZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const verifiedZip = await JSZip.loadAsync(outputBuffer);
    await validatePackageXml(verifiedZip);
    const beforeHashes = await packagePayloadHashes(originalZip);
    const afterHashes = await packagePayloadHashes(verifiedZip);
    const packageDiff = diffHashMaps(beforeHashes, afterHashes);
    const allowedParts = new Set(updatesByPart.keys());
    const unexpected = [
      ...packageDiff.added.map((part) => ({ operation: "added", part })),
      ...packageDiff.removed.map((part) => ({ operation: "removed", part })),
      ...packageDiff.changed.filter((part) => !allowedParts.has(part)).map((part) => ({ operation: "changed", part })),
    ];
    if (unexpected.length > 0) {
      throw blocked("unsafe-recalculation-merge", "Package-preserving recalculation produced unexpected package changes", { unexpected });
    }
    const updated = [...updatesByPart.values()].reduce((sum, updates) => sum + updates.length, 0);
    if (updated === 0) {
      if (verified > 0) {
        await atomicWriteBuffer(outputPath, originalBuffer);
        return {
          status: skipped.length > 0 ? "partial" : "ok",
          outcome: skipped.length > 0 ? "verified_with_preserved_formulas" : "verified_cache_current",
          engine: "LibreOffice",
          input: path.resolve(inputPath),
          output: path.resolve(outputPath),
          formulas: { total: originalRecords.length, updated: 0, verified, preserved: skipped.length, skipped: skipped.slice(0, 100) },
          package: { changedParts: [], unchangedParts: beforeHashes.size, addedParts: [], removedParts: [] },
        };
      }
      return {
        status: "unsupported",
        outcome: "no_formula_results_merged",
        input: path.resolve(inputPath),
        output: null,
        formulas: { total: originalRecords.length, updated: 0, verified: 0, preserved: skipped.length, skipped: skipped.slice(0, 100) },
      };
    }
    await atomicWriteBuffer(outputPath, outputBuffer);
    return {
      status: skipped.length > 0 ? "partial" : "ok",
      outcome: skipped.length > 0 ? "recalculated_with_preserved_formulas" : "recalculated",
      engine: "LibreOffice",
      input: path.resolve(inputPath),
      output: path.resolve(outputPath),
      formulas: { total: originalRecords.length, updated, verified, preserved: skipped.length, skipped: skipped.slice(0, 100) },
      package: { changedParts: packageDiff.changed, unchangedParts: packageDiff.unchanged, addedParts: packageDiff.added, removedParts: packageDiff.removed },
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function validateXlsx(filePath) {
  const { zip } = await loadPackage(filePath);
  await validatePackageXml(zip);
  const records = await collectFormulaRecords(zip);
  const formulas = formulaReport(records, 100);
  const facts = await packageFacts(zip);
  const findings = [
    ...formulas.missingCachedResults.map((item) => ({ type: "missing_formula_cache", ...item })),
    ...formulas.errors.map((item) => ({ type: "formula_error_value", ...item })),
    ...formulas.invalidReferences.map((item) => ({ type: "formula_invalid_reference", ...item })),
    ...formulas.compatibilityRisks.map((item) => ({ type: "formula_compatibility_risk", ...item })),
  ];
  return {
    status: findings.length > 0 ? "partial" : "ok",
    path: path.resolve(filePath),
    format: "xlsx",
    packageValid: true,
    workbook: { worksheetCount: facts.worksheets.length, worksheets: facts.worksheets },
    package: { entryCount: facts.entryCount, features: facts.features },
    formulas,
    findings,
  };
}

async function validateDelimited(filePath) {
  const inspection = await inspectDelimited(filePath, { "max-rows": 5, "max-cols": 20 });
  const findings = [];
  if (inspection.rowCount === 0) findings.push({ type: "empty_file" });
  if (inspection.inconsistentRowWidths) findings.push({ type: "inconsistent_row_widths" });
  return { ...inspection, status: findings.length > 0 ? "partial" : "ok", findings };
}

async function collectCellFacts(zip, maximum = 250000) {
  const cells = new Map();
  let total = 0;
  for (const sheet of await workbookSheets(zip)) {
    const document = parseXml(await zip.file(sheet.part).async("string"), sheet.part);
    for (const cell of elementsByLocalName(document, "c")) {
      total += 1;
      if (cells.size >= maximum) continue;
      const formula = directChild(cell, "f");
      const value = directChild(cell, "v");
      const inline = directChild(cell, "is");
      cells.set(`${sheet.name}!${cell.getAttribute("r")}`, {
        style: cell.getAttribute("s") || null,
        type: cell.getAttribute("t") || null,
        formula: formula?.textContent ?? null,
        formulaType: formula?.getAttribute("t") ?? null,
        value: value?.textContent ?? inline?.textContent ?? null,
      });
    }
  }
  return { cells, total, truncated: total > maximum };
}

function compareValueMaps(before, after, maximum = 50) {
  const keys = new Set([...before.keys(), ...after.keys()]);
  const changes = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const key of [...keys].sort()) {
    if (!before.has(key)) {
      added += 1;
      if (changes.length < maximum) changes.push({ key, operation: "added", after: after.get(key) });
    } else if (!after.has(key)) {
      removed += 1;
      if (changes.length < maximum) changes.push({ key, operation: "removed", before: before.get(key) });
    } else if (JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key))) {
      changed += 1;
      if (changes.length < maximum) changes.push({ key, operation: "changed", before: before.get(key), after: after.get(key) });
    }
  }
  return { added, removed, changed, sample: changes, truncated: added + removed + changed > changes.length };
}

async function compareXlsx(beforePath, afterPath) {
  const beforePackage = await loadPackage(beforePath);
  const afterPackage = await loadPackage(afterPath);
  await Promise.all([validatePackageXml(beforePackage.zip), validatePackageXml(afterPackage.zip)]);
  const [beforeHashes, afterHashes, beforeRecords, afterRecords, beforeCells, afterCells, beforeFacts, afterFacts] = await Promise.all([
    packagePayloadHashes(beforePackage.zip),
    packagePayloadHashes(afterPackage.zip),
    collectFormulaRecords(beforePackage.zip),
    collectFormulaRecords(afterPackage.zip),
    collectCellFacts(beforePackage.zip),
    collectCellFacts(afterPackage.zip),
    packageFacts(beforePackage.zip),
    packageFacts(afterPackage.zip),
  ]);
  const packageDiff = diffHashMaps(beforeHashes, afterHashes);
  const formulaMap = (records) => new Map(records.map((record) => [formulaKey(record), {
    formula: record.formula,
    formulaType: record.formulaType,
    cellType: record.cellType,
    cachePresent: record.hasCache,
    cachedValue: record.cachedValue,
  }]));
  const formulas = compareValueMaps(formulaMap(beforeRecords), formulaMap(afterRecords));
  const cells = compareValueMaps(beforeCells.cells, afterCells.cells);
  const worksheetBefore = new Map(beforeFacts.worksheets.map((sheet) => [sheet.name, sheet]));
  const worksheetAfter = new Map(afterFacts.worksheets.map((sheet) => [sheet.name, sheet]));
  const worksheets = compareValueMaps(worksheetBefore, worksheetAfter);
  const different = packageDiff.added.length + packageDiff.removed.length + packageDiff.changed.length > 0;
  return {
    status: "ok",
    before: path.resolve(beforePath),
    after: path.resolve(afterPath),
    different,
    package: packageDiff,
    worksheets,
    formulas,
    cells: { ...cells, beforeTotal: beforeCells.total, afterTotal: afterCells.total, sourceTruncated: beforeCells.truncated || afterCells.truncated },
    features: { before: beforeFacts.features, after: afterFacts.features },
    judgment: "This report records differences and does not decide whether they were requested or acceptable.",
  };
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
    if (!await pathExists(convertedPath)) throw new Error(`LibreOffice did not convert the legacy workbook. ${conversion.stderr || conversion.stdout}`.trim());
    await validateXlsx(convertedPath);
    await atomicWriteBuffer(outputPath, await fs.readFile(convertedPath));
    return { status: "ok", input: path.resolve(inputPath), output: path.resolve(outputPath), engine: "LibreOffice" };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function inspectSpreadsheet(filePath, options = {}) {
  const extension = assertSupportedInput(filePath, { legacy: true });
  if (extension === ".xlsx") return inspectXlsx(filePath, options);
  if (extension === ".csv" || extension === ".tsv") return inspectDelimited(filePath, options);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-inspect-"));
  try {
    const converted = path.join(tempRoot, "converted.xlsx");
    await convertLegacyXls(filePath, converted);
    const report = await inspectXlsx(converted, options);
    return { ...report, path: path.resolve(filePath), format: "xls", convertedForInspection: true };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function naturalPageSort(left, right) {
  const leftNumber = Number(left.match(/(\d+)(?=\.png$)/)?.[1] ?? 0);
  const rightNumber = Number(right.match(/(\d+)(?=\.png$)/)?.[1] ?? 0);
  return leftNumber - rightNumber || left.localeCompare(right);
}

async function delimitedToXlsx(inputPath, outputPath) {
  const extension = workbookExtension(inputPath);
  const decoded = decodeDelimited(await fs.readFile(inputPath), "auto");
  const rows = parseDelimitedText(decoded.text, { bom: true, delimiter: extension === ".tsv" ? "\t" : ",", relax_column_count: true, relax_quotes: true });
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Data");
  worksheet.addRows(rows);
  await workbook.xlsx.writeFile(outputPath);
}

async function xlsxForRender(inputPath, tempRoot) {
  const extension = workbookExtension(inputPath);
  if (extension === ".xlsx") return inputPath;
  const output = path.join(tempRoot, "render-source.xlsx");
  if (extension === ".xls") await convertLegacyXls(inputPath, output);
  else await delimitedToXlsx(inputPath, output);
  return output;
}

async function renderSpreadsheet(inputPath, outputDir, explicitPdf = null) {
  const renderer = findRenderer();
  if (!renderer || (path.isAbsolute(renderer) && !await pathExists(renderer))) {
    throw unsupported("pdf-renderer-unavailable", "No PDF page renderer was found");
  }
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-render-"));
  try {
    const sourceDir = path.join(tempRoot, "source");
    const pdfDir = path.join(tempRoot, "pdf");
    const profileDir = path.join(tempRoot, "profile");
    await Promise.all([fs.mkdir(sourceDir, { recursive: true }), fs.mkdir(pdfDir, { recursive: true }), fs.mkdir(profileDir, { recursive: true }), fs.mkdir(outputDir, { recursive: true })]);
    for (const name of await fs.readdir(outputDir)) {
      if (/^page-?\d+\.png$/i.test(name)) await fs.rm(path.join(outputDir, name), { force: true });
    }
    const sourceWorkbook = await xlsxForRender(inputPath, tempRoot);
    const sourcePath = path.join(sourceDir, "workbook.xlsx");
    await fs.copyFile(sourceWorkbook, sourcePath);
    const conversion = await runLibreOffice(["--convert-to", "pdf:calc_pdf_Export", "--outdir", pdfDir, sourcePath], profileDir);
    const generatedPdf = path.join(pdfDir, "workbook.pdf");
    if (!await pathExists(generatedPdf)) throw new Error(`LibreOffice did not produce a PDF. ${conversion.stderr || conversion.stdout}`.trim());
    const finalPdf = explicitPdf ?? path.join(outputDir, "workbook.pdf");
    await atomicWriteBuffer(finalPdf, await fs.readFile(generatedPdf));
    const prefix = path.join(outputDir, "page");
    const name = path.basename(renderer).toLowerCase();
    if (name.startsWith("pdftoppm")) await execFileAsync(renderer, ["-png", "-r", "144", generatedPdf, prefix], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    else if (name.startsWith("mutool")) await execFileAsync(renderer, ["draw", "-r", "144", "-o", `${prefix}-%d.png`, generatedPdf], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    else await execFileAsync(renderer, ["-density", "144", generatedPdf, `${prefix}-%d.png`], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    const pages = (await fs.readdir(outputDir)).filter((item) => /^page-?\d+\.png$/i.test(item)).sort(naturalPageSort).map((item) => path.resolve(outputDir, item));
    if (pages.length === 0) throw new Error("The PDF renderer produced no page images");
    return { pdf: path.resolve(finalPdf), pages, pageCount: pages.length };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function commandInspect(options) {
  const input = path.resolve(requireOption(options, "input"));
  const output = options.out ? assertInternalPath(requireOption(options, "out"), "Inspection report") : null;
  assertDistinctPaths({ input, output });
  await emitReport(await inspectSpreadsheet(input, options), output);
}

async function commandValidate(options) {
  const input = path.resolve(requireOption(options, "input"));
  const output = options.out ? assertInternalPath(requireOption(options, "out"), "Validation report") : null;
  assertDistinctPaths({ input, output });
  const extension = assertSupportedInput(input);
  const report = extension === ".xlsx" ? await validateXlsx(input) : await validateDelimited(input);
  await emitReport(report, output);
}

async function commandCompare(options) {
  const before = path.resolve(requireOption(options, "before"));
  const after = path.resolve(requireOption(options, "after"));
  const output = assertInternalPath(requireOption(options, "out"), "Comparison report");
  assertDistinctPaths({ before, after, output });
  if (workbookExtension(before) !== ".xlsx" || workbookExtension(after) !== ".xlsx") throw new Error("compare accepts two .xlsx files");
  await emitReport(await compareXlsx(before, after), output);
}

async function commandRecalculate(options) {
  const input = path.resolve(requireOption(options, "input"));
  const output = assertInternalPath(requireOption(options, "out"), "Recalculated workbook");
  const reportPath = options.report ? assertInternalPath(requireOption(options, "report"), "Recalculation report") : null;
  assertDistinctPaths({ input, output, report: reportPath });
  if (workbookExtension(input) !== ".xlsx" || workbookExtension(output) !== ".xlsx") throw new Error("recalculate accepts .xlsx input and output only");
  try {
    const report = await recalculatePreservingPackage(input, output);
    await emitReport(report, reportPath);
  } catch (error) {
    if (error instanceof SpreadsheetProtocolError && error.status === "unsupported") {
      await emitReport({ status: "unsupported", code: error.code, message: error.message, ...error.details, input, output: null }, reportPath);
      return;
    }
    throw error;
  }
}

async function commandConvertLegacy(options) {
  const input = path.resolve(requireOption(options, "input"));
  const output = assertInternalPath(requireOption(options, "out"), "Converted workbook");
  const reportPath = options.report ? assertInternalPath(requireOption(options, "report"), "Conversion report") : null;
  assertDistinctPaths({ input, output, report: reportPath });
  await emitReport(await convertLegacyXls(input, output), reportPath);
}

async function commandRender(options) {
  const input = path.resolve(requireOption(options, "input"));
  const outputDir = assertInternalPath(requireOption(options, "out-dir"), "Render directory");
  const pdf = options.pdf ? assertInternalPath(requireOption(options, "pdf"), "Rendered PDF") : null;
  const reportPath = options.report ? assertInternalPath(requireOption(options, "report"), "Render report") : null;
  assertDistinctPaths({ input, outputDir, pdf, report: reportPath });
  assertSupportedInput(input, { legacy: true });
  try {
    const render = await renderSpreadsheet(input, outputDir, pdf);
    await emitReport({ status: "ok", input, ...render }, reportPath);
  } catch (error) {
    if (error instanceof SpreadsheetProtocolError && error.status === "unsupported") {
      await emitReport({ status: "unsupported", code: error.code, message: error.message, input }, reportPath);
      return;
    }
    throw error;
  }
}

async function deliverSpreadsheet({ input, output, source = null, replaceSource = false }) {
  const inputExtension = assertSupportedInput(input);
  if (inputExtension !== workbookExtension(output)) throw new Error("Candidate and deliverable formats must match");
  if (pathsReferToSameLocation(input, output)) throw new Error("Deliverable must be distinct from the internal candidate");
  const replacingSource = source && pathsReferToSameLocation(source, output);
  if (replaceSource && !replacingSource) throw new Error("--replace-source requires --source and --out to identify the same source file");
  if (replacingSource && !replaceSource) throw blocked("source-replacement-not-authorized", "Refusing to replace the source workbook without --replace-source");
  if (await pathExists(output) && !replacingSource) throw new Error(`Refusing to overwrite existing deliverable: ${output}`);
  const validation = inputExtension === ".xlsx" ? await validateXlsx(input) : await validateDelimited(input);
  let recovery = null;
  if (replacingSource) {
    const workDir = pilotDeckWorkDir();
    if (!workDir) throw new Error("PILOTDECK_WORK_DIR is required for recoverable source replacement");
    recovery = path.join(workDir, "spreadsheets", "recovery", `${path.basename(source)}.${Date.now()}.bak`);
    await ensureParent(recovery);
    await fs.copyFile(source, recovery);
  }
  const buffer = await fs.readFile(input);
  await atomicWriteBuffer(output, buffer);
  const candidateHash = sha256(buffer);
  const outputHash = await fileSha256(output);
  if (candidateHash !== outputHash) throw new Error("Final deliverable does not match the candidate workbook");
  return { status: "ok", output: path.resolve(output), sha256: outputHash, candidate: { path: path.resolve(input), sha256: candidateHash }, recovery, validation };
}

async function commandDeliver(options) {
  const input = assertInternalPath(requireOption(options, "input"), "Spreadsheet candidate");
  const output = assertDeliveryPath(requireOption(options, "out"));
  const source = options.source ? path.resolve(requireOption(options, "source")) : null;
  const replaceSource = Boolean(options["replace-source"]);
  const reportPath = options.report ? assertInternalPath(requireOption(options, "report"), "Delivery report") : null;
  assertDistinctPaths({ input, report: reportPath });
  await emitReport(await deliverSpreadsheet({ input, output, source, replaceSource }), reportPath);
}

function conditionalFormattingFingerprint(zip, sheetPart) {
  return zip.file(sheetPart).async("string").then((xml) => {
    const document = parseXml(xml, sheetPart);
    return sha256(Buffer.from(elementsByLocalName(document, "conditionalFormatting").map((node) => new XMLSerializer().serializeToString(node)).join("\n"), "utf8"));
  });
}

async function commandSelfTest(options) {
  const root = options.out
    ? path.join(path.resolve(String(options.out)), `run-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`)
    : await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-self-test-"));
  const workDir = path.join(root, "work");
  await fs.mkdir(workDir, { recursive: true });
  const previousWorkDir = process.env.PILOTDECK_WORK_DIR;
  process.env.PILOTDECK_WORK_DIR = workDir;
  const checks = [];
  const assert = (condition, name) => {
    if (!condition) throw new Error(`Self-test failed: ${name}`);
    checks.push(name);
  };
  try {
    const candidate = path.join(workDir, "candidate.xlsx");
    const recalculated = path.join(workDir, "recalculated.xlsx");
    const comparisonPath = path.join(workDir, "comparison.json");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("计算");
    sheet.addRows([["值", "结果"], [2, { formula: "SUM(A2:A3)", result: 0 }], [3, { formula: "IF(A2>0,\"yes\",\"no\")", result: "" }], [null, { formula: "A2>A3", result: true }], [null, { formula: "A2-A2", result: 9 }]]);
    sheet.getCell("C1").value = "共享公式";
    sheet.getCell("C2").value = { formula: "A2*2", result: 99 };
    sheet.getCell("C3").value = { sharedFormula: "C2", result: 99 };
    sheet.getCell("D1").value = "缺失缓存";
    sheet.getCell("D2").value = { formula: "A2+A3" };
    sheet.getCell("E1").value = "错误值";
    sheet.getCell("E2").value = { formula: "1/0", result: { error: "#VALUE!" } };
    sheet.getCell("F1").value = "日期";
    sheet.getCell("F2").value = { formula: "DATE(2026,1,2)", result: 0 };
    sheet.getCell("F2").numFmt = "yyyy-mm-dd";
    sheet.addConditionalFormatting({ ref: "A2:A3", rules: [{ type: "cellIs", operator: "greaterThan", formulae: [2], style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } } } }] });
    await workbook.xlsx.writeFile(candidate);
    const validation = await validateXlsx(candidate);
    assert(validation.packageValid, "validate package");
    const inspection = await inspectXlsx(candidate, { sheet: "计算", range: "A1:B5", styles: true });
    assert(inspection.selection?.cells?.length > 0, "inspect range");

    const beforePackage = await loadPackage(candidate);
    const beforeSheets = await workbookSheets(beforePackage.zip);
    const sheetPart = beforeSheets.find((item) => item.name === "计算").part;
    const beforeConditionalFormatting = await conditionalFormattingFingerprint(beforePackage.zip, sheetPart);
    const beforeStyles = await beforePackage.zip.file("xl/styles.xml").async("nodebuffer");
    let recalculation;
    try {
      recalculation = await recalculatePreservingPackage(candidate, recalculated);
    } catch (error) {
      if (error instanceof SpreadsheetProtocolError && error.status === "unsupported") {
        recalculation = { status: "unsupported", message: error.message };
      } else {
        throw error;
      }
    }
    if (recalculation.status !== "unsupported") {
      assert(recalculation.status === "ok", "recalculate supported formulas");
      const recalculatedPackage = await loadPackage(recalculated);
      const records = new Map((await collectFormulaRecords(recalculatedPackage.zip)).map((record) => [formulaKey(record), record]));
      assert(Number(records.get("计算!B2")?.cachedValue) === 5, "numeric formula cache");
      assert(records.get("计算!B3")?.cachedValue === "yes", "string formula cache");
      assert(records.get("计算!B4")?.cachedValue === "0", "boolean formula cache");
      assert(Number(records.get("计算!B5")?.cachedValue) === 0, "falsey numeric cache");
      assert(Number(records.get("计算!C2")?.cachedValue) === 4 && Number(records.get("计算!C3")?.cachedValue) === 6, "shared formula caches");
      assert(Number(records.get("计算!D2")?.cachedValue) === 5, "missing formula cache populated");
      assert(records.get("计算!E2")?.cellType === "e" && /^#DIV\/0!/i.test(records.get("计算!E2")?.cachedValue ?? ""), "formula error cache");
      assert(Number(records.get("计算!F2")?.cachedValue) > 45000, "date formula cache");
      assert(await conditionalFormattingFingerprint(recalculatedPackage.zip, sheetPart) === beforeConditionalFormatting, "conditional formatting preserved");
      assert(sha256(await recalculatedPackage.zip.file("xl/styles.xml").async("nodebuffer")) === sha256(beforeStyles), "styles part preserved");
      const comparison = await compareXlsx(candidate, recalculated);
      assert(comparison.package.added.length === 0 && comparison.package.removed.length === 0, "recalculate package entries preserved");
      await writeJson(comparisonPath, comparison);
    } else {
      checks.push("recalculate skipped: LibreOffice unavailable");
    }

    const noFormula = path.join(workDir, "no-formula.xlsx");
    const noFormulaOutput = path.join(workDir, "no-formula-output.xlsx");
    const simple = new ExcelJS.Workbook();
    simple.addWorksheet("Data").addRows([["A"], [1]]);
    await simple.xlsx.writeFile(noFormula);
    const noFormulaResult = await recalculatePreservingPackage(noFormula, noFormulaOutput);
    assert(noFormulaResult.outcome === "skipped_no_formulas", "skip workbook without formulas");
    assert(await fileSha256(noFormula) === await fileSha256(noFormulaOutput), "no-formula workbook copied exactly");

    const unsupportedFormula = path.join(workDir, "unsupported-formula.xlsx");
    const unsupportedOutput = path.join(workDir, "unsupported-output.xlsx");
    const advanced = new ExcelJS.Workbook();
    advanced.addWorksheet("Data").getCell("A1").value = { formula: "_xlfn.FILTER(B1:B3,B1:B3>0)", result: 1 };
    await advanced.xlsx.writeFile(unsupportedFormula);
    const unsupportedResult = await recalculatePreservingPackage(unsupportedFormula, unsupportedOutput);
    assert(unsupportedResult.status === "unsupported" && unsupportedResult.output === null, "preserve unsupported formulas without round trip");
    assert(!await pathExists(unsupportedOutput), "unsupported recalculation emits no candidate");

    const mixedFormula = path.join(workDir, "mixed-formula.xlsx");
    const mixedOutput = path.join(workDir, "mixed-output.xlsx");
    const mixed = new ExcelJS.Workbook();
    const mixedSheet = mixed.addWorksheet("Data");
    mixedSheet.getCell("A1").value = { formula: "1+1", result: 0 };
    mixedSheet.getCell("A2").value = { formula: "_xlfn.FILTER(B1:B3,B1:B3>0)", result: 7 };
    await mixed.xlsx.writeFile(mixedFormula);
    const mixedResult = await recalculatePreservingPackage(mixedFormula, mixedOutput);
    assert(mixedResult.status === "partial" && mixedResult.formulas.updated === 1 && mixedResult.formulas.preserved === 1, "partially recalculate mixed formula support");
    const mixedRecords = new Map((await collectFormulaRecords((await loadPackage(mixedOutput)).zip)).map((record) => [formulaKey(record), record]));
    assert(mixedRecords.get("Data!A1")?.cachedValue === "2", "supported formula updated in mixed workbook");
    assert(mixedRecords.get("Data!A2")?.formula === "_xlfn.FILTER(B1:B3,B1:B3>0)" && mixedRecords.get("Data!A2")?.cachedValue === "7", "unsupported formula and cache preserved in mixed workbook");

    const deliverable = path.join(root, "final.xlsx");
    const deliveredInput = await pathExists(recalculated) ? recalculated : candidate;
    const delivery = await deliverSpreadsheet({ input: deliveredInput, output: deliverable });
    assert(await fileSha256(deliverable) === await fileSha256(deliveredInput) && delivery.sha256 === await fileSha256(deliveredInput), "atomic delivery bytes");
    let overwriteBlocked = false;
    try {
      await deliverSpreadsheet({ input: deliveredInput, output: deliverable });
    } catch {
      overwriteBlocked = true;
    }
    assert(overwriteBlocked, "delivery refuses unrelated overwrite");

    const sourceWorkbook = path.join(root, "source.xlsx");
    await fs.copyFile(noFormula, sourceWorkbook);
    let sourceBlocked = false;
    try {
      await deliverSpreadsheet({ input: deliveredInput, output: sourceWorkbook, source: sourceWorkbook });
    } catch (error) {
      sourceBlocked = error instanceof SpreadsheetProtocolError && error.code === "source-replacement-not-authorized";
    }
    assert(sourceBlocked, "delivery requires explicit source replacement");
    const replacement = await deliverSpreadsheet({ input: deliveredInput, output: sourceWorkbook, source: sourceWorkbook, replaceSource: true });
    assert(replacement.recovery && await pathExists(replacement.recovery), "source replacement creates recovery copy");
    assert(await fileSha256(sourceWorkbook) === await fileSha256(deliveredInput), "authorized source replacement delivers candidate");

    const report = { status: "ok", root, checks, recalculation };
    await emitReport(report, options.report ? String(options.report) : null);
  } finally {
    if (previousWorkDir === undefined) delete process.env.PILOTDECK_WORK_DIR;
    else process.env.PILOTDECK_WORK_DIR = previousWorkDir;
  }
}

function printHelp() {
  process.stdout.write(`PilotDeck spreadsheets skill\n\nCore commands:\n  inspect --input book.xlsx [--sheet Sheet1 --range A1:H20 --styles --out report.json]\n  validate --input book.xlsx [--out report.json]\n  render --input book.xlsx --out-dir render [--pdf render.pdf]\n  deliver --input candidate.xlsx --out final.xlsx [--source source.xlsx --replace-source]\n\nOptional mechanical commands:\n  recalculate --input candidate.xlsx --out recalculated.xlsx [--report report.json]\n  compare --before source.xlsx --after candidate.xlsx --out comparison.json\n  convert-legacy --input source.xls --out converted.xlsx\n  self-test [--out directory]\n`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "inspect": await commandInspect(options); break;
    case "validate": await commandValidate(options); break;
    case "compare": await commandCompare(options); break;
    case "recalculate": await commandRecalculate(options); break;
    case "convert-legacy": await commandConvertLegacy(options); break;
    case "render": await commandRender(options); break;
    case "deliver": await commandDeliver(options); break;
    case "self-test": await commandSelfTest(options); break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    default:
      throw new Error(`Unknown command '${command}'. Run spreadsheet.sh help.`);
  }
}

main().catch((error) => {
  const report = error instanceof SpreadsheetProtocolError
    ? { status: error.status, code: error.code, message: error.message, ...error.details }
    : { status: "error", message: error instanceof Error ? error.message : String(error) };
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = error instanceof SpreadsheetProtocolError ? 3 : 1;
});
