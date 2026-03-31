const fs = require("fs");
const path = require("path");

const MAX_TEXT_CHARS = 200000;
const MAX_ARRAY_ITEMS = 500;
const MAX_OBJECT_KEYS = 500;
const MAX_DEPTH = 8;

function truncateText(value, max = MAX_TEXT_CHARS) {
  const text = String(value || "");
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}

function normalizeValue(value, depth = 0) {
  if (depth > MAX_DEPTH) {
    return "[max-depth]";
  }
  if (value === undefined) {
    return null;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return truncateText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return truncateText(value.toString("utf8"));
  }
  if (value instanceof URLSearchParams) {
    return truncateText(value.toString());
  }
  if (value instanceof Map) {
    return normalizeValue(Object.fromEntries(value.entries()), depth + 1);
  }
  if (value instanceof Set) {
    return normalizeValue([...value.values()], depth + 1);
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => normalizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const output = {};
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    entries.forEach(([key, val]) => {
      output[key] = normalizeValue(val, depth + 1);
    });
    return output;
  }
  return truncateText(String(value));
}

function headersToObject(headers) {
  if (!headers) {
    return {};
  }
  if (typeof headers.entries === "function") {
    const output = {};
    for (const [key, value] of headers.entries()) {
      output[key] = value;
    }
    return output;
  }
  if (typeof headers === "object") {
    return { ...headers };
  }
  return { value: String(headers) };
}

class ApiCallLogger {
  constructor(filePath) {
    this.filePath = filePath;
  }

  ensureDir() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  log(event) {
    this.ensureDir();
    const entry = {
      timestamp: new Date().toISOString(),
      ...normalizeValue(event),
    };
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }
}

let currentLogger = null;

function configureApiCallLogger(filePath) {
  currentLogger = new ApiCallLogger(filePath);
  return currentLogger;
}

function getApiCallLogger() {
  return currentLogger;
}

function logApiCall(event) {
  if (!currentLogger) {
    return null;
  }
  try {
    return currentLogger.log(event);
  } catch (_error) {
    return null;
  }
}

module.exports = {
  ApiCallLogger,
  configureApiCallLogger,
  getApiCallLogger,
  logApiCall,
  headersToObject,
  normalizeValue,
  truncateText,
};

