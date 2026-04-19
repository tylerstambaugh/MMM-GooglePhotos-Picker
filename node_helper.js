const NodeHelper = require("node_helper");
const QRCode = require("qrcode");
const GPhotosPicker = require("./GPhotosPicker.js");
const PhotoCache = require("./PhotoCache.js");
const { shuffle } = require("./shuffle.js");

const authOption = require("./google_auth.json");

module.exports = NodeHelper.create({
  start: function () {
    this.picker = null;
    this.config = null;
    this.cache = new PhotoCache();
    this.sessionId = null;
    this.sessionReady = false;
  },

  socketNotificationReceived: function (notification, payload) {
    switch (notification) {
      case "INIT":
        if (!this.config) {
          this.config = payload;
          this.initialize();
        }
        break;
      case "NEED_MORE_PICS":
        if (!this.cache.isEmpty()) this.sendPhotos();
        break;
      case "IMAGE_LOADED":
        break;
      case "IMAGE_LOAD_FAIL":
        this.log("Image load failed:", payload?.url);
        break;
      case "MODULE_SUSPENDED_SKIP_UPDATE":
        break;
    }
  },

  initialize: async function () {
    try {
      this.picker = new GPhotosPicker({
        authOption: authOption,
        debug: this.config.debug || false,
      });
      this.cache.load();

      // Cache-first: if we already have photos on disk, rotate them and skip
      // the Picker API entirely. Session expiry no longer matters.
      if (!this.cache.isEmpty()) {
        this.log(
          "Cache has",
          this.cache.count(),
          "photos — skipping picker, starting rotation.",
        );
        this.sendSocketNotification("INITIALIZED", []);
        this.sendPhotos();
        return;
      }

      // Empty cache — check for a saved session we can resume (e.g. a crash
      // mid-pick or mid-download on the previous run).
      const saved = this.picker.loadSavedSession();
      if (saved && saved.id) {
        this.log("Attempting to resume saved session:", saved.id);
        try {
          const session = await this.picker.getSession(saved.id);
          if (session.mediaItemsSet) {
            this.log("Saved session has photos ready — downloading to cache.");
            this.sessionId = saved.id;
            this.sessionReady = true;
            await this.downloadAndCachePhotos();
            return;
          }
          this.log("Saved session still active, resuming poll for selection.");
          this.sessionId = saved.id;
          if (saved.pickerUri) {
            await this.sendPickerSession(saved.pickerUri, saved.id);
          }
          this.pollForSelection();
          return;
        } catch (e) {
          this.log(
            "Saved session invalid or expired, creating new.",
            e.message || "",
          );
          this.picker.clearSession();
        }
      }

      await this.createNewSession();
    } catch (err) {
      this.logError("Initialization error:", err.toString());
      this.sendSocketNotification("ERROR", err.toString());
      // Retry after 5 minutes
      setTimeout(() => {
        this.config = null;
        this.initialize();
      }, 5 * 60 * 1000);
    }
  },

  sendPickerSession: async function (pickerUri, sessionId) {
    try {
      const qrDataUrl = await QRCode.toDataURL(pickerUri, {
        width: 300,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });
      this.sendSocketNotification("PICKER_SESSION", {
        pickerUri: pickerUri,
        qrCode: qrDataUrl,
        sessionId: sessionId,
      });
    } catch (err) {
      this.logError("QR code generation failed:", err.toString());
      this.sendSocketNotification("PICKER_SESSION", {
        pickerUri: pickerUri,
        qrCode: null,
        sessionId: sessionId,
      });
    }
  },

  createNewSession: async function () {
    try {
      const session = await this.picker.createSession();
      this.sessionId = session.id;
      this.sessionReady = false;

      await this.sendPickerSession(session.pickerUri, session.id);

      this.log("Picker session created. Waiting for user to select photos...");
      this.log("Picker URI:", session.pickerUri);

      this.pollForSelection();
    } catch (err) {
      this.logError("Failed to create picker session:", err.toString());
      this.sendSocketNotification(
        "ERROR",
        "Failed to create photo picker session: " + err.toString(),
      );
    }
  },

  pollForSelection: async function () {
    try {
      const ready = await this.picker.pollSession(
        this.sessionId,
        (status) => {
          this.sendSocketNotification("UPDATE_STATUS", status);
        },
      );

      if (ready) {
        this.sessionReady = true;
        this.sendSocketNotification("CLEAR_ERROR");
        await this.downloadAndCachePhotos();
      } else {
        this.log("Picker session timed out. Creating new session...");
        this.picker.clearSession();
        await this.createNewSession();
      }
    } catch (err) {
      this.logError("Poll error:", err.toString());
      this.sendSocketNotification(
        "ERROR",
        "Error waiting for photo selection: " + err.toString(),
      );
      setTimeout(() => this.pollForSelection(), 2 * 60 * 1000);
    }
  },

  /**
   * Eager download: pull every picked photo to disk at display resolution,
   * then start rotation. Errors propagate so `initialize` can retry.
   */
  downloadAndCachePhotos: async function () {
    const items = await this.picker.listMediaItems(this.sessionId);

    const photos = items.filter(
      (item) =>
        item.type === "PHOTO" ||
        (item.mediaFile &&
          item.mediaFile.mimeType &&
          item.mediaFile.mimeType.startsWith("image/")),
    );

    if (photos.length === 0) {
      this.sendSocketNotification(
        "ERROR",
        "No photos found in selection. Please select some photos.",
      );
      return;
    }

    const width = this.config.showWidth || 1080;
    const height = this.config.showHeight || 1920;
    let success = 0;
    let failed = 0;

    this.log(`Starting eager download of ${photos.length} photos…`);

    for (let i = 0; i < photos.length; i++) {
      const item = photos[i];
      if (this.cache.has(item.id)) {
        success++;
        continue;
      }
      const mediaFile = item.mediaFile || {};
      if (!mediaFile.baseUrl) {
        failed++;
        continue;
      }
      this.sendSocketNotification(
        "UPDATE_STATUS",
        `Downloading photo ${i + 1} of ${photos.length}…`,
      );
      try {
        const buffer = await this.picker.downloadPhoto(
          mediaFile.baseUrl,
          width,
          height,
        );
        this.cache.add(item.id, buffer, {
          mimeType: mediaFile.mimeType || "image/jpeg",
          creationTime: item.createTime || new Date().toISOString(),
          width: mediaFile.mediaFileMetadata?.width || null,
          height: mediaFile.mediaFileMetadata?.height || null,
        });
        // Persist after each download so a mid-batch crash keeps progress
        this.cache.save();
        success++;
      } catch (err) {
        this.logError(
          `Download failed for ${item.id}:`,
          err.message || err.toString(),
        );
        failed++;
      }
    }

    if (success === 0) {
      throw new Error(
        `All ${photos.length} photo downloads failed — check auth and network.`,
      );
    }

    this.log(
      `Download complete: ${success} succeeded, ${failed} failed. Cache has ${this.cache.count()} photos.`,
    );

    // Session has done its job. Drop it so a stale ID isn't resumed next boot.
    this.picker.clearSession();
    this.sessionId = null;
    this.sessionReady = false;

    this.sendSocketNotification("INITIALIZED", []);
    this.sendPhotos();
  },

  sendPhotos: function () {
    const photos = this.cache.list();
    if (photos.length === 0) return;

    const payload = photos.map((p) => ({
      id: p.id,
      baseUrl: p.url,
      mimeType: p.mimeType,
      mediaMetadata: {
        creationTime: p.creationTime,
        width: p.width ? String(p.width) : "1920",
        height: p.height ? String(p.height) : "1080",
      },
    }));

    let sorted;
    if (this.config.sort === "random") {
      sorted = shuffle([...payload]);
    } else if (this.config.sort === "old") {
      sorted = [...payload].sort(
        (a, b) =>
          new Date(a.mediaMetadata.creationTime) -
          new Date(b.mediaMetadata.creationTime),
      );
    } else {
      sorted = [...payload].sort(
        (a, b) =>
          new Date(b.mediaMetadata.creationTime) -
          new Date(a.mediaMetadata.creationTime),
      );
    }

    this.sendSocketNotification("MORE_PICS", sorted);
  },

  log: function (...args) {
    console.log("[MMM-GooglePhotos]", ...args);
  },

  logError: function (...args) {
    console.error("[MMM-GooglePhotos]", ...args);
  },
});
