const fs = require("fs");
const path = require("path");

class AuditLogger {
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
      ...event,
    };
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  readRecent(limit = 200) {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }
    const text = fs.readFileSync(this.filePath, "utf8");
    if (!text.trim()) {
      return [];
    }

    const lines = text.trim().split(/\r?\n/);
    return lines
      .slice(-Math.max(1, limit))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  }

  clear() {
    this.ensureDir();
    fs.writeFileSync(this.filePath, "", "utf8");
    return { cleared: true, clearedAt: new Date().toISOString() };
  }
}

module.exports = {
  AuditLogger,
};
