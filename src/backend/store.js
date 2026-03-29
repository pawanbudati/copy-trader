const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

class FileStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.version = 1;
  }

  ensureDir() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  deriveKey() {
    const host = os.hostname();
    const user = os.userInfo().username;
    const seed = `${host}:${user}:alice-copy-trader:v1`;
    return crypto.pbkdf2Sync(seed, "alice-copy-trader-salt", 120000, 32, "sha256");
  }

  encrypt(plainText) {
    const iv = crypto.randomBytes(12);
    const key = this.deriveKey();
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plainText, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return JSON.stringify({
      v: this.version,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: encrypted.toString("base64"),
    });
  }

  decrypt(payload) {
    const parsed = JSON.parse(payload);
    if (parsed.v !== this.version) {
      throw new Error("Unsupported store version");
    }

    const key = this.deriveKey();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(parsed.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));

    const plain = Buffer.concat([
      decipher.update(Buffer.from(parsed.data, "base64")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  }

  read() {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }

    const payload = fs.readFileSync(this.filePath, "utf8");
    const plain = this.decrypt(payload);
    return JSON.parse(plain);
  }

  write(data) {
    this.ensureDir();
    const payload = this.encrypt(JSON.stringify(data, null, 2));
    fs.writeFileSync(this.filePath, payload, "utf8");
  }
}

module.exports = {
  FileStore,
};
