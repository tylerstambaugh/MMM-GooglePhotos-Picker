"use strict";

const fs = require("fs");
const path = require("path");

const CACHE_DIR = path.resolve(__dirname, "cache");
const INDEX_FILE = path.join(CACHE_DIR, "index.json");
const URL_PREFIX = "/modules/MMM-GooglePhotos/cache/";
const INDEX_VERSION = 1;

class PhotoCache {
  constructor() {
    this.index = { version: INDEX_VERSION, savedAt: 0, photos: {} };
  }

  load() {
    if (!fs.existsSync(INDEX_FILE)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
      if (parsed.version !== INDEX_VERSION) return;
      if (!parsed.photos || typeof parsed.photos !== "object") return;
      // Drop entries whose backing file is missing
      for (const [id, meta] of Object.entries(parsed.photos)) {
        if (!meta || !meta.filename) continue;
        const filePath = path.join(CACHE_DIR, meta.filename);
        if (fs.existsSync(filePath)) {
          this.index.photos[id] = meta;
        }
      }
    } catch {
      // Corrupted index — treat as empty cache
    }
  }

  isEmpty() {
    return this.count() === 0;
  }

  count() {
    return Object.keys(this.index.photos).length;
  }

  has(id) {
    return Object.prototype.hasOwnProperty.call(this.index.photos, id);
  }

  add(id, buffer, metadata) {
    const ext = this.#extForMime(metadata.mimeType);
    const filename = `${this.#safeFilename(id)}.${ext}`;
    const filePath = path.join(CACHE_DIR, filename);
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(filePath, buffer);
    this.index.photos[id] = {
      filename,
      mimeType: metadata.mimeType || "image/jpeg",
      creationTime: metadata.creationTime || new Date().toISOString(),
      width: metadata.width || null,
      height: metadata.height || null,
    };
  }

  list() {
    return Object.entries(this.index.photos).map(([id, meta]) => ({
      id,
      url: URL_PREFIX + meta.filename,
      mimeType: meta.mimeType,
      creationTime: meta.creationTime,
      width: meta.width,
      height: meta.height,
    }));
  }

  save() {
    this.index.savedAt = Date.now();
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(this.index, null, 2));
  }

  #extForMime(mime) {
    const m = String(mime || "").toLowerCase();
    if (m.includes("png")) return "png";
    if (m.includes("webp")) return "webp";
    if (m.includes("gif")) return "gif";
    return "jpg";
  }

  #safeFilename(id) {
    // Picker IDs are base64url-ish; strip anything non-alphanumeric just in case
    return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
  }
}

module.exports = PhotoCache;
