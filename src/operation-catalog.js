import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const PLACEHOLDER_PATTERN = /^\{\{([A-Za-z][A-Za-z0-9_.]*)\}\}$/;
const EMBEDDED_PLACEHOLDER_PATTERN = /\{\{([A-Za-z][A-Za-z0-9_.]*)\}\}/g;
const MAX_COMPOSITION_DEPTH = 40;
const MAX_EXPANDED_COMMANDS = 500;

export class OperationCatalog {
  constructor({ projectRoot = null, directories = null } = {}) {
    if (!projectRoot && !Array.isArray(directories)) {
      throw new Error("projectRoot or directories is required for the operation catalog.");
    }
    this.directories = Array.isArray(directories)
      ? directories.map((directory) => path.resolve(directory))
      : [path.join(projectRoot, "operations")];
    this.operations = null;
  }

  async load() {
    if (this.operations) return this.operations;
    const operations = new Map();
    for (const directory of this.directories) {
      const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
      for (const file of files) {
        const catalog = JSON.parse(await readFile(path.join(directory, file), "utf8"));
        validateCatalog(catalog, file);
        for (const [name, definition] of Object.entries(catalog.operations)) {
          if (operations.has(name)) throw new Error(`Duplicate named operation '${name}'.`);
          operations.set(name, {
            name,
            catalogId: catalog.id,
            browserBundleIdentifier: catalog.browserBundleIdentifier,
            ...definition
          });
        }
      }
    }
    this.operations = operations;
    return operations;
  }

  async list() {
    const operations = await this.load();
    return [...operations.values()].map(({ name, description, parameters = {}, browserBundleIdentifier, command, reader }) => ({
      name,
      description,
      kind: command ? "atomic" : reader ? "reader" : "composite",
      parameters,
      browserBundleIdentifier
    }));
  }

  async expand(name, parameters = {}) {
    const operations = await this.load();
    const expanded = expandOperation(operations, name, parameters, []);
    if (expanded.nodes.length > MAX_EXPANDED_COMMANDS) {
      throw new Error(`Operation '${name}' expanded to more than ${MAX_EXPANDED_COMMANDS} execution nodes.`);
    }
    return {
      ...expanded,
      command: expanded.commands.length === 1 ? expanded.commands[0] : undefined
    };
  }
}

function expandOperation(operations, name, parameters, stack) {
  const definition = operations.get(name);
  if (!definition) throw new Error(`Unknown named operation '${name}'.`);
  if (stack.includes(name)) {
    throw new Error(`Operation composition cycle detected: ${[...stack, name].join(" -> ")}.`);
  }
  if (stack.length >= MAX_COMPOSITION_DEPTH) {
    throw new Error(`Operation composition exceeds ${MAX_COMPOSITION_DEPTH} levels at '${name}'.`);
  }

  const normalizedParameters = validateParameters(name, definition.parameters || {}, parameters);
  if (definition.command) {
    const command = resolveTemplate(structuredClone(definition.command), normalizedParameters);
    return {
      name,
      description: definition.description,
      kind: "atomic",
      browserBundleIdentifier: definition.browserBundleIdentifier,
      nodes: [{ type: "command", operation: name, command }],
      commands: [command],
      trace: [{ operation: name, commandId: command.id }]
    };
  }
  if (definition.reader) {
    const reader = resolveTemplate(structuredClone(definition.reader), normalizedParameters);
    const node = { type: "reader", operation: name, handler: reader.handler, input: reader.input || {} };
    return {
      name,
      description: definition.description,
      kind: "reader",
      browserBundleIdentifier: definition.browserBundleIdentifier,
      nodes: [node],
      commands: [],
      trace: [{ operation: name, readerHandler: reader.handler }]
    };
  }

  const nodes = [];
  const commands = [];
  const trace = [];
  for (const step of definition.steps) {
    const childExpansions = expandStep(operations, step, normalizedParameters, [...stack, name]);
    for (const child of childExpansions) {
      if (child.browserBundleIdentifier !== definition.browserBundleIdentifier) {
        throw new Error(`Composite operation '${name}' cannot call '${child.name}' with a different browser bundle identifier.`);
      }
      nodes.push(...child.nodes);
      commands.push(...child.commands);
      trace.push(...child.trace);
      if (nodes.length > MAX_EXPANDED_COMMANDS) {
        throw new Error(`Operation '${name}' expanded to more than ${MAX_EXPANDED_COMMANDS} execution nodes.`);
      }
    }
  }
  if (nodes.length === 0) throw new Error(`Composite operation '${name}' expanded to zero execution nodes.`);
  return {
    name,
    description: definition.description,
    kind: "composite",
    browserBundleIdentifier: definition.browserBundleIdentifier,
    nodes,
    commands,
    trace
  };
}

function expandStep(operations, step, context, stack) {
  if (step.operation) {
    const parameters = resolveTemplate(structuredClone(step.parameters || {}), context);
    return [expandOperation(operations, step.operation, parameters, stack)];
  }
  if (step.forEach) {
    const collection = resolveTemplate(step.forEach, context);
    const alias = String(step.as || "item");
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(alias)) throw new Error(`Invalid forEach alias '${alias}'.`);
    const entries = Array.isArray(collection)
      ? collection.map((value, index) => ({ key: index, index, value }))
      : isPlainObject(collection)
      ? Object.entries(collection).map(([key, value], index) => ({ key, index, value }))
      : null;
    if (!entries) throw new Error("forEach requires an array or object value.");
    if (entries.length > 100) throw new Error("forEach cannot expand more than 100 entries.");
    const expansions = [];
    for (const entry of entries) {
      const nestedContext = { ...context, [alias]: entry };
      for (const nestedStep of step.steps || []) {
        expansions.push(...expandStep(operations, nestedStep, nestedContext, stack));
      }
    }
    return expansions;
  }
  throw new Error("Composite operation steps must call an operation or declare forEach.");
}

function validateCatalog(catalog, source) {
  if (![1, 2].includes(catalog?.schemaVersion) || !catalog.id || !catalog.browserBundleIdentifier || !catalog.operations || typeof catalog.operations !== "object") {
    throw new Error(`Invalid operation catalog '${source}'.`);
  }
  for (const [name, definition] of Object.entries(catalog.operations)) {
    const kinds = Number(Boolean(definition?.command)) + Number(Boolean(definition?.reader)) + Number(Array.isArray(definition?.steps));
    if (!name || !definition?.description || kinds !== 1) {
      throw new Error(`Invalid named operation '${name}' in '${source}': exactly one of command, reader, or steps is required.`);
    }
    if (definition.reader && (typeof definition.reader.handler !== "string" || !definition.reader.handler || !isPlainObject(definition.reader.input || {}))) {
      throw new Error(`Invalid named reader '${name}' in '${source}'.`);
    }
  }
}

function validateParameters(operationName, schema, parameters) {
  if (!isPlainObject(parameters)) throw new Error(`Parameters for '${operationName}' must be an object.`);
  const unexpected = Object.keys(parameters).filter((name) => !Object.hasOwn(schema, name));
  if (unexpected.length > 0) throw new Error(`Unexpected parameter(s) for '${operationName}': ${unexpected.join(", ")}.`);
  const result = {};
  for (const [name, rules] of Object.entries(schema)) {
    const value = parameters[name];
    if (value === undefined) {
      if (rules.required !== false) throw new Error(`Missing required parameter '${name}' for '${operationName}'.`);
      result[name] = structuredClone(rules.default);
      continue;
    }
    result[name] = validateValue(value, rules, `${operationName}.${name}`, 0);
  }
  return result;
}

function validateValue(value, rules, pathLabel, depth) {
  if (depth > 12) throw new Error(`Parameter '${pathLabel}' exceeds the maximum nesting depth.`);
  if (Array.isArray(rules.anyOf)) {
    const errors = [];
    for (const option of rules.anyOf) {
      try { return validateValue(value, option, pathLabel, depth + 1); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    throw new Error(`Parameter '${pathLabel}' does not match any allowed schema: ${errors.join("; ")}`);
  }
  if (Array.isArray(rules.enum) && !rules.enum.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`Parameter '${pathLabel}' is not an allowed value.`);
  }
  if (rules.type === "string") {
    if (typeof value !== "string") throw new Error(`Parameter '${pathLabel}' must be a string.`);
    if (value.length < Number(rules.minLength ?? 0) || value.length > Number(rules.maxLength ?? 10_000)) {
      throw new Error(`Parameter '${pathLabel}' has an invalid length.`);
    }
    return value;
  }
  if (rules.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`Parameter '${pathLabel}' must be a boolean.`);
    return value;
  }
  if (rules.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Parameter '${pathLabel}' must be a finite number.`);
    if (rules.integer === true && !Number.isInteger(value)) throw new Error(`Parameter '${pathLabel}' must be an integer.`);
    if (value < Number(rules.minimum ?? Number.NEGATIVE_INFINITY) || value > Number(rules.maximum ?? Number.POSITIVE_INFINITY)) {
      throw new Error(`Parameter '${pathLabel}' is outside the allowed range.`);
    }
    return value;
  }
  if (rules.type === "array") {
    if (!Array.isArray(value)) throw new Error(`Parameter '${pathLabel}' must be an array.`);
    if (value.length < Number(rules.minItems ?? 0) || value.length > Number(rules.maxItems ?? 100)) {
      throw new Error(`Parameter '${pathLabel}' has an invalid item count.`);
    }
    return value.map((item, index) => validateValue(item, rules.items || {}, `${pathLabel}[${index}]`, depth + 1));
  }
  if (rules.type === "object") {
    if (!isPlainObject(value)) throw new Error(`Parameter '${pathLabel}' must be an object.`);
    const entries = Object.entries(value);
    if (entries.length < Number(rules.minProperties ?? 0) || entries.length > Number(rules.maxProperties ?? 100)) {
      throw new Error(`Parameter '${pathLabel}' has an invalid property count.`);
    }
    const properties = rules.properties || {};
    const result = {};
    for (const [name, childRules] of Object.entries(properties)) {
      if (value[name] === undefined) {
        if (childRules.required !== false) throw new Error(`Missing required parameter '${pathLabel}.${name}'.`);
        result[name] = structuredClone(childRules.default);
      } else {
        result[name] = validateValue(value[name], childRules, `${pathLabel}.${name}`, depth + 1);
      }
    }
    for (const [name, childValue] of entries) {
      if (Object.hasOwn(properties, name)) continue;
      if (rules.additionalProperties === false) throw new Error(`Unexpected parameter '${pathLabel}.${name}'.`);
      result[name] = rules.additionalProperties && typeof rules.additionalProperties === "object"
        ? validateValue(childValue, rules.additionalProperties, `${pathLabel}.${name}`, depth + 1)
        : validateJsonValue(childValue, `${pathLabel}.${name}`, depth + 1);
    }
    return result;
  }
  return validateJsonValue(value, pathLabel, depth + 1);
}

function validateJsonValue(value, pathLabel, depth) {
  if (depth > 12) throw new Error(`Parameter '${pathLabel}' exceeds the maximum nesting depth.`);
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return structuredClone(value);
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error(`Parameter '${pathLabel}' has too many items.`);
    return value.map((item, index) => validateJsonValue(item, `${pathLabel}[${index}]`, depth + 1));
  }
  if (isPlainObject(value)) {
    if (Object.keys(value).length > 100) throw new Error(`Parameter '${pathLabel}' has too many properties.`);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, validateJsonValue(item, `${pathLabel}.${key}`, depth + 1)]));
  }
  throw new Error(`Parameter '${pathLabel}' must be JSON-compatible.`);
}

function resolveTemplate(value, context) {
  if (typeof value === "string") {
    const match = value.match(PLACEHOLDER_PATTERN);
    if (match) return structuredClone(resolvePath(context, match[1]));
    return value.replace(EMBEDDED_PLACEHOLDER_PATTERN, (_, expression) => {
      const replacement = resolvePath(context, expression);
      if (!["string", "number", "boolean"].includes(typeof replacement)) {
        throw new Error(`Embedded template '${expression}' must resolve to a primitive value.`);
      }
      return String(replacement);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplate(item, context));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplate(item, context)]));
  return value;
}

function resolvePath(context, expression) {
  let value = context;
  for (const segment of expression.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, segment)) {
      throw new Error(`Template references unavailable value '${expression}'.`);
    }
    value = value[segment];
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}
