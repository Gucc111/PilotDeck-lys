import crypto from "node:crypto";
import path from "node:path";

export const NUMERIC_INTEGRITY_PROTOCOL = "pilotdeck-numeric-integrity/v1";
export const SOURCE_EVIDENCE_PROTOCOL = "pilotdeck-source-evidence/v1";

const STRUCTURED_OPERATION_TYPES = new Set(["copy", "union", "join", "aggregate", "formula"]);
const OPERATION_TYPES = new Set([...STRUCTURED_OPERATION_TYPES, "ocr"]);
const FIELD_TYPES = new Set(["decimal", "integer", "number", "identifier", "string", "boolean", "date"]);

function fail(message) {
  throw new Error(message);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be a non-empty string`);
  return value.trim();
}

function validateKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(`${label} contains unsupported key(s): ${unknown.join(", ")}`);
}

function validateColumns(columns, fields, label) {
  requireObject(columns, label);
  if (Object.keys(columns).length === 0) fail(`${label} must declare at least one logical field`);
  for (const [field, column] of Object.entries(columns)) {
    if (!Object.hasOwn(fields, field)) fail(`${label}.${field} is not declared in fields`);
    if (typeof column !== "string" || !/^[A-Z]+$/i.test(column.trim())) {
      fail(`${label}.${field} must be an Excel column name such as A or BC`);
    }
  }
}

function validateRegion(region, fields, label, { source = false } = {}) {
  requireObject(region, label);
  const allowed = new Set(["sheet", "range", "columns", "skipBlankRows", ...(source ? ["source"] : [])]);
  validateKeys(region, allowed, label);
  if (source) {
    requireNonEmptyString(region.source, `${label}.source`);
    if (!path.isAbsolute(region.source)) fail(`${label}.source must be an absolute path`);
  }
  requireNonEmptyString(region.sheet, `${label}.sheet`);
  if (!/^[A-Z]+\d+:[A-Z]+\d+$/i.test(requireNonEmptyString(region.range, `${label}.range`))) {
    fail(`${label}.range must be an explicit rectangular A1 range`);
  }
  validateColumns(region.columns, fields, `${label}.columns`);
  if (region.skipBlankRows !== undefined && typeof region.skipBlankRows !== "boolean") {
    fail(`${label}.skipBlankRows must be true or false`);
  }
}

function validateField(field, label) {
  requireObject(field, label);
  validateKeys(field, new Set(["semanticType", "scale", "tolerance", "unit", "currency", "allowBlank"]), label);
  const semanticType = requireNonEmptyString(field.semanticType, `${label}.semanticType`).toLowerCase();
  if (field.semanticType !== semanticType) fail(`${label}.semanticType must use lowercase '${semanticType}'`);
  if (!FIELD_TYPES.has(semanticType)) fail(`${label}.semanticType must be one of ${[...FIELD_TYPES].join(", ")}`);
  if (field.scale !== undefined && (!Number.isInteger(field.scale) || field.scale < 0 || field.scale > 12)) {
    fail(`${label}.scale must be an integer from 0 to 12`);
  }
  if (semanticType === "decimal" && !Number.isInteger(field.scale)) fail(`${label}.scale is required for decimal fields`);
  if (field.tolerance !== undefined && (!Number.isFinite(field.tolerance) || field.tolerance < 0)) {
    fail(`${label}.tolerance must be a non-negative number`);
  }
  if (field.unit !== undefined) requireNonEmptyString(field.unit, `${label}.unit`);
  if (field.currency !== undefined) requireNonEmptyString(field.currency, `${label}.currency`);
  if (field.allowBlank !== undefined && typeof field.allowBlank !== "boolean") fail(`${label}.allowBlank must be true or false`);
}

function validateOperation(operation, index, ids) {
  const label = `integrity plan operations[${index}]`;
  requireObject(operation, label);
  validateKeys(operation, new Set([
    "id", "type", "fields", "inputs", "output", "keyColumns", "duplicatePolicy",
    "missingMatchPolicy", "preserveOrder", "groupBy", "measures", "calculations", "facts",
  ]), label);
  const id = requireNonEmptyString(operation.id, `${label}.id`);
  if (ids.has(id)) fail(`${label}.id '${id}' is duplicated`);
  ids.add(id);
  const type = requireNonEmptyString(operation.type, `${label}.type`).toLowerCase();
  if (operation.type !== type) fail(`${label}.type must use lowercase '${type}'`);
  if (!OPERATION_TYPES.has(type)) {
    fail(`${label}.type '${type}' is not supported by this runtime`);
  }
  requireObject(operation.fields, `${label}.fields`);
  if (Object.keys(operation.fields).length === 0) fail(`${label}.fields must not be empty`);
  for (const [name, field] of Object.entries(operation.fields)) {
    requireNonEmptyString(name, `${label}.fields name`);
    validateField(field, `${label}.fields.${name}`);
  }
  if (type === "ocr") {
    validateKeys(operation, new Set(["id", "type", "fields", "output", "facts"]), label);
    requireObject(operation.output, `${label}.output`);
    validateKeys(operation.output, new Set(["sheet"]), `${label}.output`);
    requireNonEmptyString(operation.output.sheet, `${label}.output.sheet`);
    if (!Array.isArray(operation.facts) || operation.facts.length === 0) fail(`${label}.facts must be a non-empty array`);
    const factIds = new Set();
    for (const [factIndex, fact] of operation.facts.entries()) {
      const factLabel = `${label}.facts[${factIndex}]`;
      requireObject(fact, factLabel);
      validateKeys(fact, new Set(["evidenceId", "cell", "field"]), factLabel);
      const evidenceId = requireNonEmptyString(fact.evidenceId, `${factLabel}.evidenceId`);
      if (factIds.has(evidenceId)) fail(`${factLabel}.evidenceId '${evidenceId}' is duplicated`);
      factIds.add(evidenceId);
      if (!/^[A-Z]+\d+$/i.test(requireNonEmptyString(fact.cell, `${factLabel}.cell`))) fail(`${factLabel}.cell must be an A1 cell reference`);
      const field = requireNonEmptyString(fact.field, `${factLabel}.field`);
      if (!Object.hasOwn(operation.fields, field)) fail(`${factLabel}.field '${field}' is not declared`);
      if (!["decimal", "integer", "number"].includes(operation.fields[field].semanticType.toLowerCase())) fail(`${factLabel}.field '${field}' must be numeric`);
    }
    return;
  }
  if (!Array.isArray(operation.inputs) || operation.inputs.length === 0) fail(`${label}.inputs must be a non-empty array`);
  if (type === "copy" && operation.inputs.length !== 1) fail(`${label}.inputs must contain exactly one source for copy`);
  if (type === "join" && operation.inputs.length < 2) fail(`${label}.inputs must contain a base and at least one lookup for join`);
  if (type === "formula" && operation.inputs.length !== 1) fail(`${label}.inputs must contain exactly one source for formula`);
  operation.inputs.forEach((input, inputIndex) => validateRegion(input, operation.fields, `${label}.inputs[${inputIndex}]`, { source: true }));
  validateRegion(operation.output, operation.fields, `${label}.output`);
  const outputFields = new Set(Object.keys(operation.output.columns));
  for (const [inputIndex, input] of operation.inputs.entries()) {
    for (const field of Object.keys(input.columns)) {
      if (!outputFields.has(field) && ["copy", "union"].includes(type)) {
        fail(`${label}.inputs[${inputIndex}].columns.${field} has no output mapping`);
      }
    }
  }
  if (operation.keyColumns !== undefined) {
    if (!Array.isArray(operation.keyColumns) || operation.keyColumns.length === 0) fail(`${label}.keyColumns must be a non-empty array`);
    for (const field of operation.keyColumns) {
      if (typeof field !== "string" || !Object.hasOwn(operation.fields, field)) fail(`${label}.keyColumns contains unknown field '${field}'`);
      if (!outputFields.has(field) || operation.inputs.some((input) => !Object.hasOwn(input.columns, field))) {
        fail(`${label}.keyColumns '${field}' must be mapped by every input and the output`);
      }
    }
  }
  if (type === "join" && (!Array.isArray(operation.keyColumns) || operation.keyColumns.length === 0)) {
    fail(`${label}.keyColumns is required for join`);
  }
  if (type === "aggregate") {
    if (!Array.isArray(operation.groupBy) || operation.groupBy.length === 0) fail(`${label}.groupBy must be a non-empty array`);
    for (const field of operation.groupBy) {
      if (!Object.hasOwn(operation.fields, field)) fail(`${label}.groupBy contains unknown field '${field}'`);
      if (!outputFields.has(field) || operation.inputs.some((input) => !Object.hasOwn(input.columns, field))) {
        fail(`${label}.groupBy '${field}' must be mapped by every input and the output`);
      }
    }
    if (!Array.isArray(operation.measures) || operation.measures.length === 0) fail(`${label}.measures must be a non-empty array`);
    const targets = new Set();
    for (const [measureIndex, measure] of operation.measures.entries()) {
      const measureLabel = `${label}.measures[${measureIndex}]`;
      requireObject(measure, measureLabel);
      validateKeys(measure, new Set(["source", "target", "operator", "rounding"]), measureLabel);
      const target = requireNonEmptyString(measure.target, `${measureLabel}.target`);
      if (targets.has(target)) fail(`${measureLabel}.target '${target}' is duplicated`);
      targets.add(target);
      if (!Object.hasOwn(operation.fields, target) || !outputFields.has(target)) fail(`${measureLabel}.target '${target}' must be declared and mapped by output`);
      const operator = requireNonEmptyString(measure.operator, `${measureLabel}.operator`).toLowerCase();
      if (!["sum", "count", "min", "max", "average"].includes(operator)) fail(`${measureLabel}.operator is invalid`);
      if (operator !== "count") {
        const sourceField = requireNonEmptyString(measure.source, `${measureLabel}.source`);
        if (!Object.hasOwn(operation.fields, sourceField) || operation.inputs.some((input) => !Object.hasOwn(input.columns, sourceField))) {
          fail(`${measureLabel}.source '${sourceField}' must be declared and mapped by every input`);
        }
      }
      if (measure.rounding !== undefined && !["half-up", "half-even", "truncate"].includes(measure.rounding)) {
        fail(`${measureLabel}.rounding must be half-up, half-even, or truncate`);
      }
    }
  }
  if (type === "formula") {
    if (!Array.isArray(operation.calculations) || operation.calculations.length === 0) fail(`${label}.calculations must be a non-empty array`);
    const targets = new Set();
    for (const [calculationIndex, calculation] of operation.calculations.entries()) {
      const calculationLabel = `${label}.calculations[${calculationIndex}]`;
      requireObject(calculation, calculationLabel);
      validateKeys(calculation, new Set(["target", "expression", "rounding", "requireFormula"]), calculationLabel);
      const target = requireNonEmptyString(calculation.target, `${calculationLabel}.target`);
      if (targets.has(target)) fail(`${calculationLabel}.target '${target}' is duplicated`);
      targets.add(target);
      if (!Object.hasOwn(operation.fields, target) || !outputFields.has(target)) fail(`${calculationLabel}.target '${target}' must be declared and mapped by output`);
      requireNonEmptyString(calculation.expression, `${calculationLabel}.expression`);
      if (calculation.rounding !== undefined && !["half-up", "half-even", "truncate"].includes(calculation.rounding)) {
        fail(`${calculationLabel}.rounding must be half-up, half-even, or truncate`);
      }
      if (calculation.requireFormula !== undefined && typeof calculation.requireFormula !== "boolean") {
        fail(`${calculationLabel}.requireFormula must be true or false`);
      }
    }
  }
  if (operation.duplicatePolicy !== undefined && !["error", "allow"].includes(operation.duplicatePolicy)) {
    fail(`${label}.duplicatePolicy must be error or allow`);
  }
  if (operation.missingMatchPolicy !== undefined && !["error", "allow-blank"].includes(operation.missingMatchPolicy)) {
    fail(`${label}.missingMatchPolicy must be error or allow-blank`);
  }
  if (operation.preserveOrder !== undefined && typeof operation.preserveOrder !== "boolean") {
    fail(`${label}.preserveOrder must be true or false`);
  }
}

export function validateNumericIntegrityPlan(plan, label = "integrity plan") {
  requireObject(plan, label);
  validateKeys(plan, new Set(["protocol", "mode", "operations", "invariants", "ocrPolicy"]), label);
  if (plan.protocol !== NUMERIC_INTEGRITY_PROTOCOL) fail(`${label}.protocol must be '${NUMERIC_INTEGRITY_PROTOCOL}'`);
  if (plan.mode !== "strict") fail(`${label}.mode must be 'strict'`);
  if (!Array.isArray(plan.operations) || plan.operations.length === 0) fail(`${label}.operations must be a non-empty array`);
  if (plan.invariants !== undefined && !Array.isArray(plan.invariants)) fail(`${label}.invariants must be an array`);
  if (plan.operations.some((operation) => operation.type === "ocr")) {
    requireObject(plan.ocrPolicy, `${label}.ocrPolicy`);
    validateKeys(plan.ocrPolicy, new Set(["minConfidence", "minIndependentObservations", "allowExplicitUserConfirmation"]), `${label}.ocrPolicy`);
    if (!Number.isFinite(plan.ocrPolicy.minConfidence) || plan.ocrPolicy.minConfidence < 0 || plan.ocrPolicy.minConfidence > 1) {
      fail(`${label}.ocrPolicy.minConfidence must be between 0 and 1`);
    }
    if (!Number.isInteger(plan.ocrPolicy.minIndependentObservations) || plan.ocrPolicy.minIndependentObservations < 2) {
      fail(`${label}.ocrPolicy.minIndependentObservations must be at least 2`);
    }
    if (plan.ocrPolicy.allowExplicitUserConfirmation !== true) fail(`${label}.ocrPolicy.allowExplicitUserConfirmation must be true`);
  } else if (plan.ocrPolicy !== undefined) {
    fail(`${label}.ocrPolicy is only valid when an ocr operation is declared`);
  }
  const ids = new Set();
  plan.operations.forEach((operation, index) => validateOperation(operation, index, ids));
  for (const [index, invariant] of (plan.invariants ?? []).entries()) {
    const invariantLabel = `${label}.invariants[${index}]`;
    requireObject(invariant, invariantLabel);
    validateKeys(invariant, new Set(["id", "type", "operation", "expression", "expected", "scale"]), invariantLabel);
    requireNonEmptyString(invariant.id, `${invariantLabel}.id`);
    if (invariant.type !== "row-expression") fail(`${invariantLabel}.type must be row-expression`);
    if (!ids.has(invariant.operation)) fail(`${invariantLabel}.operation references unknown operation '${invariant.operation}'`);
    requireNonEmptyString(invariant.expression, `${invariantLabel}.expression`);
    if (!Object.hasOwn(invariant, "expected")) fail(`${invariantLabel}.expected is required`);
    requireNonEmptyString(String(invariant.expected), `${invariantLabel}.expected`);
    if (!Number.isInteger(invariant.scale) || invariant.scale < 0 || invariant.scale > 12) fail(`${invariantLabel}.scale must be an integer from 0 to 12`);
  }
  return plan;
}

function normalizeExponent(value) {
  const text = String(value).trim();
  if (!/[eE]/.test(text)) return text;
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/);
  if (!match) return text;
  const sign = match[1];
  const integer = match[2];
  const fraction = match[3] ?? "";
  const exponent = Number.parseInt(match[4], 10);
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  if (decimalIndex <= 0) return `${sign}0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${sign}${digits}${"0".repeat(decimalIndex - digits.length)}`;
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function decimalParts(value) {
  const text = normalizeExponent(value);
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) fail(`'${value}' is not a finite decimal value`);
  const sign = match[1] === "-" ? -1n : 1n;
  const fraction = match[3] ?? "";
  return { coefficient: sign * BigInt(`${match[2]}${fraction}`), scale: fraction.length };
}

function pow10(scale) {
  return 10n ** BigInt(scale);
}

function quantizeDecimal(value, scale) {
  const parts = decimalParts(value);
  if (parts.scale === scale) return parts.coefficient;
  if (parts.scale < scale) return parts.coefficient * pow10(scale - parts.scale);
  const divisor = pow10(parts.scale - scale);
  const quotient = parts.coefficient / divisor;
  const remainder = parts.coefficient % divisor;
  if (remainder === 0n) return quotient;
  const magnitude = remainder < 0n ? -remainder : remainder;
  const direction = parts.coefficient < 0n ? -1n : 1n;
  return magnitude * 2n >= divisor ? quotient + direction : quotient;
}

function bigintAbs(value) {
  return value < 0n ? -value : value;
}

function bigintGcd(left, right) {
  let a = bigintAbs(left);
  let b = bigintAbs(right);
  while (b !== 0n) [a, b] = [b, a % b];
  return a || 1n;
}

function rational(numerator, denominator = 1n) {
  if (denominator === 0n) fail("Division by zero in numeric-integrity expression");
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = bigintGcd(numerator, denominator);
  return { numerator: sign * numerator / divisor, denominator: bigintAbs(denominator) / divisor };
}

function rationalFromDecimal(value) {
  const parts = decimalParts(value);
  return rational(parts.coefficient, pow10(parts.scale));
}

function addRational(left, right) {
  return rational(left.numerator * right.denominator + right.numerator * left.denominator, left.denominator * right.denominator);
}

function subtractRational(left, right) {
  return rational(left.numerator * right.denominator - right.numerator * left.denominator, left.denominator * right.denominator);
}

function multiplyRational(left, right) {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

function divideRational(left, right) {
  if (right.numerator === 0n) fail("Division by zero in numeric-integrity expression");
  return rational(left.numerator * right.denominator, left.denominator * right.numerator);
}

function compareRational(left, right) {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

function quantizeRational(value, scale, rounding = "half-up") {
  const scaledNumerator = value.numerator * pow10(scale);
  const quotient = scaledNumerator / value.denominator;
  const remainder = scaledNumerator % value.denominator;
  if (remainder === 0n || rounding === "truncate") return quotient;
  const magnitude = bigintAbs(remainder);
  const doubled = magnitude * 2n;
  const direction = scaledNumerator < 0n ? -1n : 1n;
  if (rounding === "half-even" && doubled === value.denominator) {
    return bigintAbs(quotient) % 2n === 0n ? quotient : quotient + direction;
  }
  return doubled >= value.denominator ? quotient + direction : quotient;
}

function fieldRational(cell, field, label) {
  const type = field.semanticType.toLowerCase();
  if (!["decimal", "integer", "number"].includes(type)) fail(`${label} is not a numeric field`);
  if (typeof cell?.value !== "number" || !Number.isFinite(cell.value)) fail(`${label} must be a finite numeric cell`);
  return rationalFromDecimal(cell.value);
}

function expressionTokens(expression) {
  expression = String(expression).trim();
  const tokens = [];
  const pattern = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([\p{L}_][\p{L}\p{N}_]*)|([()+\-*/]))/guy;
  let index = 0;
  while (index < expression.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(expression);
    if (!match || match.index !== index) fail(`Invalid token in numeric-integrity expression near '${expression.slice(index)}'`);
    tokens.push(match[1] ? { type: "number", value: match[1] } : match[2] ? { type: "identifier", value: match[2] } : { type: "operator", value: match[3] });
    index = pattern.lastIndex;
  }
  return tokens;
}

function evaluateExpression(expression, cells, fields) {
  const tokens = expressionTokens(expression);
  let position = 0;
  const peek = () => tokens[position];
  const consume = () => tokens[position++];
  const parsePrimary = () => {
    const token = consume();
    if (!token) fail(`Unexpected end of numeric-integrity expression '${expression}'`);
    if (token.type === "number") return rationalFromDecimal(token.value);
    if (token.type === "identifier") {
      if (!Object.hasOwn(fields, token.value)) fail(`Expression references unknown field '${token.value}'`);
      if (!Object.hasOwn(cells, token.value)) fail(`Expression field '${token.value}' is not mapped by this row`);
      return fieldRational(cells[token.value], fields[token.value], `expression field '${token.value}'`);
    }
    if (token.value === "(") {
      const value = parseAdditive();
      if (consume()?.value !== ")") fail(`Unclosed parenthesis in numeric-integrity expression '${expression}'`);
      return value;
    }
    if (token.value === "+") return parsePrimary();
    if (token.value === "-") {
      const value = parsePrimary();
      return rational(-value.numerator, value.denominator);
    }
    fail(`Unexpected token '${token.value}' in numeric-integrity expression`);
  };
  const parseMultiplicative = () => {
    let value = parsePrimary();
    while (peek()?.value === "*" || peek()?.value === "/") {
      const operator = consume().value;
      const right = parsePrimary();
      value = operator === "*" ? multiplyRational(value, right) : divideRational(value, right);
    }
    return value;
  };
  const parseAdditive = () => {
    let value = parseMultiplicative();
    while (peek()?.value === "+" || peek()?.value === "-") {
      const operator = consume().value;
      const right = parseMultiplicative();
      value = operator === "+" ? addRational(value, right) : subtractRational(value, right);
    }
    return value;
  };
  const result = parseAdditive();
  if (position !== tokens.length) fail(`Unexpected token '${tokens[position].value}' in numeric-integrity expression`);
  return result;
}

function numericCellFromRational(value, field, rounding = "half-up") {
  const semanticType = field.semanticType.toLowerCase();
  if (semanticType === "integer") {
    const scaled = quantizeRational(value, 0, rounding);
    const number = Number(scaled);
    if (!Number.isSafeInteger(number)) fail("Calculated integer exceeds Excel safe integer precision");
    return { value: number, type: "number", formula: null, numberFormat: null };
  }
  const scale = semanticType === "decimal" ? field.scale : 12;
  const scaled = quantizeRational(value, scale, rounding);
  const number = Number(scaled) / Number(pow10(scale));
  if (!Number.isFinite(number)) fail("Calculated numeric value is not finite");
  return { value: number, type: "number", formula: null, numberFormat: null };
}

function canonicalExternalNumeric(value, field, label) {
  const semanticType = field.semanticType.toLowerCase();
  if (!["decimal", "integer", "number"].includes(semanticType)) fail(`${label} must use a numeric semantic type`);
  const parsed = rationalFromDecimal(value);
  if (semanticType === "decimal") {
    const scaled = quantizeRational(parsed, field.scale, "half-up");
    return { canonical: `decimal:${field.scale}:${scaled}`, value: scaled };
  }
  if (semanticType === "integer") {
    const scaled = quantizeRational(parsed, 0, "half-up");
    if (compareRational(parsed, rational(scaled)) !== 0) fail(`${label} is not an integer`);
    return { canonical: `integer:${scaled}`, value: scaled };
  }
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`${label} is not a finite number`);
  return { canonical: `number:${number}`, value: number };
}

function isBlank(value) {
  return value === null || value === undefined || value === "";
}

function normalizeValue(cell, field, label) {
  const semanticType = field.semanticType.toLowerCase();
  const value = cell?.value;
  if (isBlank(value)) {
    if (field.allowBlank) return { canonical: "blank", value: null };
    fail(`${label} is blank`);
  }
  if (semanticType === "decimal") {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be a numeric cell, not ${cell?.type ?? typeof value}`);
    const scaled = quantizeDecimal(value, field.scale);
    return { canonical: `decimal:${field.scale}:${scaled}`, value: scaled };
  }
  if (semanticType === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(`${label} must be a safe integer numeric cell`);
    return { canonical: `integer:${value}`, value: BigInt(value) };
  }
  if (semanticType === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be a finite numeric cell`);
    return { canonical: `number:${value}`, value };
  }
  if (semanticType === "identifier" || semanticType === "string") {
    if (typeof value !== "string") fail(`${label} must be a text cell`);
    return { canonical: `${semanticType}:${value}`, value };
  }
  if (semanticType === "boolean") {
    if (typeof value !== "boolean") fail(`${label} must be a boolean cell`);
    return { canonical: `boolean:${value}`, value };
  }
  if (semanticType === "date") {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail(`${label} must be a date cell`);
    return { canonical: `date:${value.toISOString()}`, value: value.toISOString() };
  }
  fail(`${label} has unsupported semantic type '${semanticType}'`);
}

function canonicalRecord(row, fields, selectedFields, label) {
  const canonical = {};
  const normalized = {};
  for (const fieldName of selectedFields) {
    const result = normalizeValue(row.values[fieldName], fields[fieldName], `${label}.${fieldName}`);
    canonical[fieldName] = result.canonical;
    normalized[fieldName] = result.value;
  }
  return { row: row.row, cells: row.values, canonical, normalized };
}

function keyFor(record, keyColumns) {
  return keyColumns.map((field) => record.canonical[field]).join("\u001f");
}

function fingerprint(record, fields) {
  const serialized = fields.map((field) => `${field}=${record.canonical[field]}`).join("\u001e");
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function valuesMatch(actual, expected, field) {
  if (field.semanticType === "number" && Number.isFinite(field.tolerance) && field.tolerance > 0) {
    return Math.abs(actual.value - expected.value) <= field.tolerance;
  }
  return actual.canonical === expected.canonical;
}

function compareRecords(expectedRows, actualRows, operation, fieldsToCompare) {
  const failures = [];
  const checks = [];
  const keyColumns = operation.keyColumns ?? [];
  const duplicatePolicy = operation.duplicatePolicy ?? "error";
  const preserveOrder = operation.preserveOrder ?? operation.type === "copy";
  const addCheck = (type, passed, details = {}) => {
    const check = { type, passed, ...details };
    checks.push(check);
    if (!passed) failures.push(check);
  };

  addCheck("record_count", expectedRows.length === actualRows.length, { expected: expectedRows.length, actual: actualRows.length });
  if (keyColumns.length > 0) {
    const buildIndex = (rows) => {
      const index = new Map();
      for (const row of rows) {
        const key = keyFor(row, keyColumns);
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(row);
      }
      return index;
    };
    const expectedIndex = buildIndex(expectedRows);
    const actualIndex = buildIndex(actualRows);
    const expectedDuplicates = [...expectedIndex.entries()].filter(([, rows]) => rows.length > 1).map(([key, rows]) => ({ key, count: rows.length }));
    const actualDuplicates = [...actualIndex.entries()].filter(([, rows]) => rows.length > 1).map(([key, rows]) => ({ key, count: rows.length }));
    addCheck("expected_key_uniqueness", duplicatePolicy === "allow" || expectedDuplicates.length === 0, { duplicates: expectedDuplicates.slice(0, 100) });
    addCheck("output_key_uniqueness", duplicatePolicy === "allow" || actualDuplicates.length === 0, { duplicates: actualDuplicates.slice(0, 100) });
    const missing = [...expectedIndex.keys()].filter((key) => !actualIndex.has(key));
    const unexpected = [...actualIndex.keys()].filter((key) => !expectedIndex.has(key));
    addCheck("key_coverage", missing.length === 0 && unexpected.length === 0, { missing: missing.slice(0, 100), unexpected: unexpected.slice(0, 100) });
    const mismatches = [];
    if (duplicatePolicy !== "allow") {
      for (const [key, expectedGroup] of expectedIndex.entries()) {
        const actualGroup = actualIndex.get(key);
        if (!actualGroup || expectedGroup.length !== 1 || actualGroup.length !== 1) continue;
        for (const fieldName of fieldsToCompare) {
          const actualValue = normalizeValue(actualGroup[0].cells[fieldName], operation.fields[fieldName], `output key ${key}.${fieldName}`);
          const expectedValue = normalizeValue(expectedGroup[0].cells[fieldName], operation.fields[fieldName], `source key ${key}.${fieldName}`);
          if (!valuesMatch(actualValue, expectedValue, operation.fields[fieldName]) && mismatches.length < 100) {
            mismatches.push({ key, field: fieldName, expected: expectedValue.canonical, actual: actualValue.canonical });
          }
        }
      }
    }
    addCheck("field_values", mismatches.length === 0, { mismatches });
    if (preserveOrder && expectedRows.length === actualRows.length) {
      const orderMismatches = [];
      for (let index = 0; index < expectedRows.length; index += 1) {
        if (keyFor(expectedRows[index], keyColumns) !== keyFor(actualRows[index], keyColumns) && orderMismatches.length < 100) {
          orderMismatches.push({ index, expected: keyFor(expectedRows[index], keyColumns), actual: keyFor(actualRows[index], keyColumns) });
        }
      }
      addCheck("record_order", orderMismatches.length === 0, { mismatches: orderMismatches });
    }
  } else {
    const expectedCounts = new Map();
    const actualCounts = new Map();
    for (const row of expectedRows) {
      const hash = fingerprint(row, fieldsToCompare);
      expectedCounts.set(hash, (expectedCounts.get(hash) ?? 0) + 1);
    }
    for (const row of actualRows) {
      const hash = fingerprint(row, fieldsToCompare);
      actualCounts.set(hash, (actualCounts.get(hash) ?? 0) + 1);
    }
    const missing = [...expectedCounts.entries()].filter(([hash, count]) => (actualCounts.get(hash) ?? 0) < count).map(([hash, count]) => ({ hash, count, actual: actualCounts.get(hash) ?? 0 }));
    const unexpected = [...actualCounts.entries()].filter(([hash, count]) => (expectedCounts.get(hash) ?? 0) < count).map(([hash, count]) => ({ hash, count, expected: expectedCounts.get(hash) ?? 0 }));
    addCheck("record_fingerprints", missing.length === 0 && unexpected.length === 0, { missing: missing.slice(0, 100), unexpected: unexpected.slice(0, 100) });
    if (preserveOrder && expectedRows.length === actualRows.length) {
      const mismatches = [];
      for (let index = 0; index < expectedRows.length; index += 1) {
        const expected = fingerprint(expectedRows[index], fieldsToCompare);
        const actual = fingerprint(actualRows[index], fieldsToCompare);
        if (expected !== actual && mismatches.length < 100) mismatches.push({ index, expected, actual });
      }
      addCheck("record_order", mismatches.length === 0, { mismatches });
    }
  }
  return { status: failures.length === 0 ? "passed" : "failed", checks, failures };
}

function mergeJoinRecords(inputs, operation) {
  const failures = [];
  const keyColumns = operation.keyColumns;
  const base = inputs[0];
  const lookupIndexes = inputs.slice(1).map((rows, lookupIndex) => {
    const index = new Map();
    for (const row of rows) {
      const key = keyFor(row, keyColumns);
      if (index.has(key)) failures.push({ type: "join_lookup_duplicate_key", input: lookupIndex + 1, key });
      else index.set(key, row);
    }
    return index;
  });
  const expected = [];
  for (const baseRow of base) {
    const key = keyFor(baseRow, keyColumns);
    const cells = { ...baseRow.cells };
    const canonical = { ...baseRow.canonical };
    const normalized = { ...baseRow.normalized };
    for (const [lookupIndex, index] of lookupIndexes.entries()) {
      const match = index.get(key);
      if (!match) {
        if ((operation.missingMatchPolicy ?? "error") === "error") failures.push({ type: "join_missing_match", input: lookupIndex + 1, key });
        continue;
      }
      for (const [field, cell] of Object.entries(match.cells)) {
        if (keyColumns.includes(field)) continue;
        if (Object.hasOwn(cells, field) && cells[field]?.value !== undefined && cells[field]?.value !== cell?.value) {
          failures.push({ type: "join_field_conflict", key, field, input: lookupIndex + 1 });
          continue;
        }
        cells[field] = cell;
        canonical[field] = match.canonical[field];
        normalized[field] = match.normalized[field];
      }
    }
    expected.push({ row: baseRow.row, cells, canonical, normalized });
  }
  return { expected, failures };
}

function aggregateRecords(inputs, operation) {
  const failures = [];
  const groups = new Map();
  for (const row of inputs.flat()) {
    const key = keyFor(row, operation.groupBy);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const expected = [];
  for (const [key, rows] of groups.entries()) {
    const first = rows[0];
    const cells = Object.fromEntries(operation.groupBy.map((field) => [field, first.cells[field]]));
    for (const measure of operation.measures) {
      const targetField = operation.fields[measure.target];
      let value;
      if (measure.operator === "count") {
        value = rational(BigInt(rows.length));
      } else {
        const values = rows.map((row) => fieldRational(row.cells[measure.source], operation.fields[measure.source], `${operation.id} group ${key}.${measure.source}`));
        if (measure.operator === "sum" || measure.operator === "average") {
          value = values.reduce((total, current) => addRational(total, current), rational(0n));
          if (measure.operator === "average") value = divideRational(value, rational(BigInt(values.length)));
        } else if (measure.operator === "min") {
          value = values.reduce((current, candidate) => compareRational(candidate, current) < 0 ? candidate : current);
        } else if (measure.operator === "max") {
          value = values.reduce((current, candidate) => compareRational(candidate, current) > 0 ? candidate : current);
        }
      }
      cells[measure.target] = numericCellFromRational(value, targetField, measure.rounding ?? "half-up");
    }
    try {
      expected.push(canonicalRecord({ row: first.row, values: cells }, operation.fields, Object.keys(operation.output.columns), `${operation.id} aggregate ${key}`));
    } catch (error) {
      failures.push({ type: "aggregate_result_invalid", key, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { expected, failures };
}

function formulaRecords(inputRows, operation) {
  const expected = [];
  const failures = [];
  for (const row of inputRows) {
    const cells = { ...row.cells };
    for (const calculation of operation.calculations) {
      try {
        const value = evaluateExpression(calculation.expression, cells, operation.fields);
        cells[calculation.target] = numericCellFromRational(value, operation.fields[calculation.target], calculation.rounding ?? "half-up");
      } catch (error) {
        failures.push({ type: "formula_recalculation_error", row: row.row, target: calculation.target, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (failures.some((failure) => failure.row === row.row)) continue;
    try {
      expected.push(canonicalRecord({ row: row.row, values: cells }, operation.fields, Object.keys(operation.output.columns), `${operation.id} formula row ${row.row}`));
    } catch (error) {
      failures.push({ type: "formula_result_invalid", row: row.row, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { expected, failures };
}

function evaluateInvariants(plan, operationRows) {
  const checks = [];
  const failures = [];
  for (const invariant of plan.invariants ?? []) {
    const context = operationRows.get(invariant.operation);
    if (!context) {
      const failure = { type: "invariant_operation_missing", invariant: invariant.id, operation: invariant.operation };
      checks.push({ ...failure, passed: false });
      failures.push(failure);
      continue;
    }
    const mismatches = [];
    for (const row of context.rows) {
      try {
        const actual = quantizeRational(evaluateExpression(invariant.expression, row.cells, context.operation.fields), invariant.scale, "half-up");
        const expected = quantizeDecimal(invariant.expected, invariant.scale);
        if (actual !== expected && mismatches.length < 100) {
          mismatches.push({ row: row.row, expected: String(expected), actual: String(actual) });
        }
      } catch (error) {
        if (mismatches.length < 100) mismatches.push({ row: row.row, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const check = {
      type: "row_expression_invariant",
      invariant: invariant.id,
      operation: invariant.operation,
      passed: mismatches.length === 0,
      checkedRows: context.rows.length,
      expression: invariant.expression,
      expected: invariant.expected,
      scale: invariant.scale,
      mismatches,
    };
    checks.push(check);
    if (!check.passed) failures.push(check);
  }
  return { status: failures.length === 0 ? "passed" : "failed", checks, failures };
}

function trustedImageFactValue(fact, policy) {
  if (fact?.confirmation?.status === "confirmed"
    && fact.confirmation.confirmedBy === "user"
    && fact.confirmation.basis === "explicit-user"
    && String(fact.confirmation.value ?? "").trim() !== "") {
    return { status: "confirmed", value: String(fact.confirmation.value), basis: "explicit-user" };
  }
  const observations = Array.isArray(fact?.observations) ? fact.observations : [];
  const qualified = observations.filter((observation) => (
    typeof observation.method === "string"
    && observation.method.trim().length > 0
    && Number.isFinite(observation.confidence)
    && observation.confidence >= policy.minConfidence
    && String(observation.normalizedValue ?? "").trim() !== ""
  ));
  const methods = new Set(qualified.map((observation) => observation.method.trim().toLowerCase()));
  const values = new Set(qualified.map((observation) => String(observation.normalizedValue).trim()));
  if (methods.size < policy.minIndependentObservations) {
    return { status: "unverified", reason: "insufficient_independent_observations", methods: [...methods], observations: qualified.length };
  }
  if (values.size !== 1) {
    return { status: "unverified", reason: "observation_disagreement", values: [...values], methods: [...methods] };
  }
  return { status: "consensus", value: [...values][0], basis: "independent-observation-consensus", methods: [...methods] };
}

async function evaluateOcrOperation(operation, plan, adapters) {
  const checks = [];
  const failures = [];
  const rows = [];
  for (const [index, reference] of operation.facts.entries()) {
    const evidence = await adapters.readImageFact(reference.evidenceId);
    if (!evidence) {
      const failure = { type: "image_evidence_missing", evidenceId: reference.evidenceId };
      failures.push(failure);
      checks.push({ ...failure, passed: false });
      continue;
    }
    const trusted = trustedImageFactValue(evidence, plan.ocrPolicy);
    if (trusted.status === "unverified") {
      const failure = { type: "image_evidence_unverified", evidenceId: reference.evidenceId, ...trusted };
      failures.push(failure);
      checks.push({ ...failure, passed: false });
      continue;
    }
    try {
      const expected = canonicalExternalNumeric(trusted.value, operation.fields[reference.field], `image evidence '${reference.evidenceId}'`);
      const actualCell = await adapters.readCandidateCell(operation.output.sheet, reference.cell);
      const actual = normalizeValue(actualCell, operation.fields[reference.field], `${operation.id}.output ${operation.output.sheet}!${reference.cell}`);
      const passed = valuesMatch(actual, expected, operation.fields[reference.field]);
      const check = {
        type: "image_fact_value",
        passed,
        evidenceId: reference.evidenceId,
        sheet: operation.output.sheet,
        cell: reference.cell,
        field: reference.field,
        trust: trusted.status,
        basis: trusted.basis,
        expected: expected.canonical,
        actual: actual.canonical,
      };
      checks.push(check);
      if (!passed) failures.push(check);
      rows.push({ row: index + 1, cells: { [reference.field]: actualCell } });
    } catch (error) {
      const failure = { type: "image_fact_comparison_error", evidenceId: reference.evidenceId, error: error instanceof Error ? error.message : String(error) };
      failures.push(failure);
      checks.push({ ...failure, passed: false });
    }
  }
  return {
    status: failures.length === 0 ? "passed" : "failed",
    checks,
    failures,
    rows,
  };
}

export async function evaluateNumericIntegrityPlan(plan, adapters) {
  validateNumericIntegrityPlan(plan);
  if (!adapters || typeof adapters.readSourceRows !== "function" || typeof adapters.readCandidateRows !== "function") {
    fail("numeric integrity adapters must provide readSourceRows and readCandidateRows");
  }
  const operations = [];
  const allFailures = [];
  const operationRows = new Map();
  for (const operation of plan.operations) {
    if (operation.type === "ocr") {
      if (typeof adapters.readImageFact !== "function" || typeof adapters.readCandidateCell !== "function") {
        fail("numeric integrity OCR operations require readImageFact and readCandidateCell adapters");
      }
      const ocr = await evaluateOcrOperation(operation, plan, adapters);
      const result = {
        id: operation.id,
        type: operation.type,
        status: ocr.status,
        sourceRecords: operation.facts.length,
        expectedOutputRecords: operation.facts.length,
        outputRecords: ocr.rows.length,
        checks: ocr.checks,
        failures: ocr.failures,
      };
      operations.push(result);
      operationRows.set(operation.id, { operation, rows: ocr.rows });
      allFailures.push(...ocr.failures.map((failure) => ({ operation: operation.id, ...failure })));
      continue;
    }
    const operationFailures = [];
    const inputRows = [];
    for (const [inputIndex, input] of operation.inputs.entries()) {
      const rawRows = await adapters.readSourceRows(input, operation);
      const fields = Object.keys(input.columns);
      const normalized = [];
      for (const row of rawRows) {
        try {
          normalized.push(canonicalRecord(row, operation.fields, fields, `${operation.id}.inputs[${inputIndex}] row ${row.row}`));
        } catch (error) {
          operationFailures.push({ type: "source_value_invalid", input: inputIndex, row: row.row, error: error instanceof Error ? error.message : String(error) });
        }
      }
      inputRows.push(normalized);
    }
    const outputRaw = await adapters.readCandidateRows(operation.output, operation);
    const outputFields = Object.keys(operation.output.columns);
    const actualRows = [];
    for (const row of outputRaw) {
      try {
        actualRows.push(canonicalRecord(row, operation.fields, outputFields, `${operation.id}.output row ${row.row}`));
      } catch (error) {
        operationFailures.push({ type: "output_value_invalid", row: row.row, error: error instanceof Error ? error.message : String(error) });
      }
    }
    let expectedRows = operation.type === "union" ? inputRows.flat() : inputRows[0];
    if (operation.type === "join") {
      const joined = mergeJoinRecords(inputRows, operation);
      expectedRows = joined.expected;
      operationFailures.push(...joined.failures);
    }
    if (operation.type === "aggregate") {
      const aggregated = aggregateRecords(inputRows, operation);
      expectedRows = aggregated.expected;
      operationFailures.push(...aggregated.failures);
    }
    if (operation.type === "formula") {
      const calculated = formulaRecords(inputRows[0], operation);
      expectedRows = calculated.expected;
      operationFailures.push(...calculated.failures);
      for (const calculation of operation.calculations) {
        if (calculation.requireFormula === false) continue;
        const missing = actualRows.filter((row) => !row.cells[calculation.target]?.formula).map((row) => row.row);
        if (missing.length > 0) operationFailures.push({ type: "required_formula_missing", target: calculation.target, rows: missing.slice(0, 100) });
      }
    }
    const comparableExpected = expectedRows.filter((row) => outputFields.every((field) => Object.hasOwn(row.cells, field)));
    if (comparableExpected.length !== expectedRows.length) {
      operationFailures.push({
        type: "source_output_mapping_incomplete",
        expectedRows: expectedRows.length,
        comparableRows: comparableExpected.length,
        outputFields,
      });
    }
    let comparison = { status: "failed", checks: [], failures: [] };
    try {
      const comparisonOperation = operation.type === "aggregate"
        ? { ...operation, keyColumns: operation.groupBy, preserveOrder: operation.preserveOrder ?? false }
        : operation;
      comparison = compareRecords(comparableExpected, actualRows, comparisonOperation, outputFields);
    } catch (error) {
      operationFailures.push({ type: "comparison_error", error: error instanceof Error ? error.message : String(error) });
    }
    operationFailures.push(...comparison.failures);
    const result = {
      id: operation.id,
      type: operation.type,
      status: operationFailures.length === 0 ? "passed" : "failed",
      sourceRecords: operation.type === "aggregate" ? inputRows.flat().length : expectedRows.length,
      expectedOutputRecords: expectedRows.length,
      outputRecords: actualRows.length,
      checks: comparison.checks,
      failures: operationFailures,
    };
    operations.push(result);
    operationRows.set(operation.id, { operation, rows: actualRows });
    allFailures.push(...operationFailures.map((failure) => ({ operation: operation.id, ...failure })));
  }
  const invariants = evaluateInvariants(plan, operationRows);
  allFailures.push(...invariants.failures.map((failure) => ({ invariant: failure.invariant, ...failure })));
  return {
    status: allFailures.length === 0 ? "passed" : "failed",
    protocol: NUMERIC_INTEGRITY_PROTOCOL,
    operations,
    invariants,
    failures: allFailures,
  };
}

export function planSourcePaths(plan) {
  validateNumericIntegrityPlan(plan);
  return [...new Set(plan.operations.flatMap((operation) => operation.inputs ?? []).map((input) => path.resolve(input.source)))];
}

export function planOutputSheets(plan) {
  validateNumericIntegrityPlan(plan);
  return [...new Set(plan.operations.map((operation) => operation.output?.sheet).filter(Boolean))];
}
