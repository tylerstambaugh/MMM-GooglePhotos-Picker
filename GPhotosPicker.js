"use strict";

const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");
const { OAuth2Client } = require("google-auth-library");
const Axios = require("axios");
const { error_to_string } = require("./error_to_string");
const { ConfigFileError, AuthError } = require("./Errors");

const PICKER_API_BASE = "https://photospicker.googleapis.com/v1/";
const SESSION_FILE = "picker_session.json";

/**
 * Sleep helper
 * @param {number} ms milliseconds
 */
function sleep(ms = 1000) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Auth class - handles OAuth2 token lifecycle
 */
class Auth extends EventEmitter {
  #config;
  #debug;

  constructor(config, debug = false) {
    super();
    this.#config = config;
    this.#debug = debug;
    this.init().then(
      () => {},
      (err) => this.emit("error", err),
    );
  }

  async init() {
    const log = this.#debug
      ? (...args) => console.log("[GPHOTOS:AUTH]", ...args)
      : () => {};

    if (!this.#config) this.#config = {};
    if (!this.#config.keyFilePath) {
      throw new ConfigFileError('Missing "keyFilePath" from config');
    }
    if (!this.#config.savedTokensPath) {
      throw new ConfigFileError('Missing "savedTokensPath" from config');
    }

    const tokenFile = path.resolve(__dirname, this.#config.savedTokensPath);
    if (!fs.existsSync(tokenFile)) {
      throw new AuthError(
        "No OAuth token found. Please run: node generate_token_v2.js",
      );
    }

    const credsFile = path.resolve(__dirname, this.#config.keyFilePath);
    if (!fs.existsSync(credsFile)) {
      throw new AuthError("Missing credentials.json file.");
    }

    const key = require(this.#config.keyFilePath).installed;
    const oauthClient = new OAuth2Client(
      key.client_id,
      key.client_secret,
      key.redirect_uris[0],
    );

    let tokensCred;

    const saveTokens = async (first = false) => {
      oauthClient.setCredentials(tokensCred);
      let expired = tokensCred.expiry_date < Date.now();
      if (expired) log("Token is expired.");

      if (expired || first) {
        const tk = await oauthClient.refreshAccessToken();
        tokensCred = tk.credentials;
        const tp = path.resolve(__dirname, this.#config.savedTokensPath);
        fs.mkdirSync(path.dirname(tp), { recursive: true });
        fs.writeFileSync(tp, JSON.stringify(tokensCred));
        log("Token is refreshed.");
        this.emit("ready", oauthClient);
      } else {
        log("Token is alive.");
        this.emit("ready", oauthClient);
      }
    };

    process.nextTick(() => {
      try {
        if (fs.existsSync(tokenFile)) {
          const data = fs.readFileSync(tokenFile);
          tokensCred = JSON.parse(data);
        }
      } catch (error) {
        console.error("[GPHOTOS:AUTH]", error);
      } finally {
        if (tokensCred !== undefined) saveTokens();
      }
    });
  }
}

/**
 * GPhotosPicker - Google Photos Picker API client
 *
 * Uses the new Picker API (photospicker.googleapis.com) which replaced
 * the Library API's read-only access in March 2025.
 *
 * Flow:
 * 1. Create a picker session → user gets a pickerUri to select photos
 * 2. Poll session until user finishes picking (mediaItemsSet = true)
 * 3. List picked media items to get baseUrls
 * 4. Use baseUrls (with auth header) to display photos
 * 5. Re-fetch media items every ~50 min to refresh baseUrls (they expire in 60 min)
 */
class GPhotosPicker {
  constructor(options) {
    this.debug = options.debug || false;
    if (!options.authOption) {
      throw new Error("Invalid auth information.");
    }
    this.options = options;
    this.sessionId = null;
    this.pickerUri = null;
    this.mediaItems = [];
    this.lastMediaFetch = 0;
    this._cachedClient = null;
    this._clientExpiry = 0;
  }

  log(...args) {
    console.info("[GPHOTOS:PICKER]", ...args);
  }

  logError(...args) {
    console.error("[GPHOTOS:PICKER]", ...args);
  }

  /**
   * Parse a protobuf Duration string (e.g. "5s", "2.5s") to milliseconds.
   * Falls back to defaultMs if parsing fails.
   */
  parseDuration(durationStr, defaultMs = 15000) {
    if (!durationStr) return defaultMs;
    const str = String(durationStr).trim();
    // Handle "5s", "2.5s", "300s" format
    const match = str.match(/^([\d.]+)s?$/);
    if (match) {
      const seconds = parseFloat(match[1]);
      if (!isNaN(seconds) && seconds > 0) return Math.round(seconds * 1000);
    }
    // Handle bare number (seconds)
    const num = parseFloat(str);
    if (!isNaN(num) && num > 0) return Math.round(num * 1000);
    return defaultMs;
  }

  /**
   * Get an authenticated OAuth2Client.
   * Caches the client and reuses it until the token is close to expiry.
   * @returns {Promise<OAuth2Client>}
   */
  async onAuthReady() {
    // Reuse cached client if token is still valid (with 2-min buffer)
    if (this._cachedClient && Date.now() < this._clientExpiry - 120000) {
      return this._cachedClient;
    }

    let auth;
    try {
      auth = new Auth(this.options.authOption, this.debug);
    } catch (e) {
      this.log(e.toString());
      throw e;
    }
    const client = await new Promise((resolve, reject) => {
      auth.on("ready", (c) => resolve(c));
      auth.on("error", (error) => reject(error));
    });
    this._cachedClient = client;
    this._clientExpiry = client.credentials.expiry_date || (Date.now() + 3600000);
    return client;
  }

  /**
   * Make an authenticated request to the Picker API
   */
  async request(token, endpoint, method = "get", params = null, data = null) {
    try {
      const config = {
        method,
        url: endpoint,
        baseURL: PICKER_API_BASE,
        headers: {
          Authorization: "Bearer " + token,
        },
      };
      if (params) config.params = params;
      if (data) config.data = data;
      return await Axios(config);
    } catch (error) {
      this.logError("Request failed:", endpoint);
      this.logError(error_to_string(error));
      throw error;
    }
  }

  /**
   * Load a saved session from disk
   * @returns {object|null} session data or null
   */
  loadSavedSession() {
    const sessionPath = path.resolve(__dirname, SESSION_FILE);
    try {
      if (fs.existsSync(sessionPath)) {
        const data = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
        if (data.id) {
          // Check expiry: use the API's expireTime if available, otherwise
          // fall back to a generous 7-day window from savedAt
          if (data.expireTime) {
            const expiry = new Date(data.expireTime).getTime();
            if (!isNaN(expiry) && Date.now() > expiry) {
              this.log("Saved session expired at", data.expireTime, "- will create new one.");
              return null;
            }
          } else if (data.savedAt) {
            const age = Date.now() - data.savedAt;
            if (age > 7 * 24 * 60 * 60 * 1000) {
              this.log("Saved session is over 7 days old, will create new one.");
              return null;
            }
          }
          // Sanitize pickerUri in case it was saved with whitespace
          if (data.pickerUri) {
            data.pickerUri = data.pickerUri.replace(/\s+/g, "");
          }
          this.log("Loaded saved session:", data.id,
            data.expireTime ? "(expires: " + data.expireTime + ")" : "");
          return data;
        }
      }
    } catch (e) {
      this.logError("Failed to load saved session:", e.message);
    }
    return null;
  }

  /**
   * Save session to disk
   */
  saveSession(sessionData) {
    const sessionPath = path.resolve(__dirname, SESSION_FILE);
    try {
      fs.writeFileSync(
        sessionPath,
        JSON.stringify({ ...sessionData, savedAt: Date.now() }),
      );
    } catch (e) {
      this.logError("Failed to save session:", e.message);
    }
  }

  /**
   * Clear saved session
   */
  clearSession() {
    const sessionPath = path.resolve(__dirname, SESSION_FILE);
    try {
      if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
    } catch (e) {
      // ignore
    }
    this.sessionId = null;
    this.pickerUri = null;
  }

  /**
   * Create a new Picker session
   * @returns {Promise<{id: string, pickerUri: string}>}
   */
  async createSession() {
    const client = await this.onAuthReady();
    const token = client.credentials.access_token;
    const response = await this.request(token, "sessions", "post", null, {});

    const session = response.data;
    this.log("createSession full response:", JSON.stringify(session, null, 2));

    // Sanitize pickerUri — remove any whitespace/newlines that may have been injected
    if (session.pickerUri) {
      session.pickerUri = session.pickerUri.replace(/\s+/g, "");
    }

    this.sessionId = session.id;
    this.pickerUri = session.pickerUri;
    this.saveSession(session);

    this.log("Created picker session:", this.sessionId);
    this.log("Picker URI:", this.pickerUri);
    if (session.expireTime) {
      this.log("Session expires at:", session.expireTime);
    }
    return session;
  }

  /**
   * Poll a session to check if user has finished picking
   * @param {string} sessionId
   * @returns {Promise<object>} session status
   */
  async getSession(sessionId) {
    const client = await this.onAuthReady();
    const token = client.credentials.access_token;
    const response = await this.request(
      token,
      `sessions/${sessionId}`,
      "get",
    );
    return response.data;
  }

  /**
   * Delete a session (cleanup)
   * @param {string} sessionId
   */
  async deleteSession(sessionId) {
    try {
      const client = await this.onAuthReady();
      const token = client.credentials.access_token;
      await this.request(token, `sessions/${sessionId}`, "delete");
      this.log("Deleted session:", sessionId);
    } catch (e) {
      this.logError("Failed to delete session:", e.message);
    }
  }

  /**
   * Poll session until mediaItemsSet is true or timeout
   * @param {string} sessionId
   * @param {function} onStatus callback for status updates
   * @returns {Promise<boolean>} true if media items are set
   */
  async pollSession(sessionId, onStatus = null) {
    const MAX_POLLS = 360; // max ~90 minutes at 15s intervals
    let polls = 0;

    while (polls < MAX_POLLS) {
      const session = await this.getSession(sessionId);

      // Log full response on first poll and every 20th poll for debugging
      if (polls === 0 || polls % 20 === 0) {
        this.log("Session poll #" + (polls + 1) + " response:", JSON.stringify(session, null, 2));
      }

      if (session.mediaItemsSet === true) {
        this.log("User has finished selecting photos!");
        return true;
      }

      // Check if session has expired
      if (session.expireTime) {
        const expiry = new Date(session.expireTime).getTime();
        if (!isNaN(expiry) && Date.now() > expiry) {
          this.log("Session has expired (expireTime:", session.expireTime + ")");
          return false;
        }
      }

      // Parse poll interval from Duration format (e.g. "5s")
      const pollInterval = this.parseDuration(
        session.pollingConfig?.pollInterval,
        15000,
      );

      // Check if the API says we timed out
      if (session.pollingConfig?.timeoutIn) {
        const timeoutMs = this.parseDuration(session.pollingConfig.timeoutIn, 0);
        if (timeoutMs <= 0) {
          this.log("Session timed out (pollingConfig.timeoutIn reached 0).");
          return false;
        }
      }

      if (onStatus) {
        const expInfo = session.expireTime
          ? " | expires: " + new Date(session.expireTime).toLocaleTimeString()
          : "";
        onStatus(
          `Waiting for photo selection... (poll ${polls + 1}, interval ${pollInterval / 1000}s${expInfo})`,
        );
      }

      await sleep(Math.max(Math.min(pollInterval, 30000), 2000));
      polls++;
    }

    this.log("Polling max reached (", MAX_POLLS, "polls).");
    return false;
  }

  /**
   * List all picked media items for a session
   * @param {string} sessionId
   * @returns {Promise<Array>} media items
   */
  async listMediaItems(sessionId) {
    const client = await this.onAuthReady();
    const token = client.credentials.access_token;
    let allItems = [];
    let pageToken = null;

    do {
      const params = { sessionId };
      if (pageToken) params.pageToken = pageToken;

      const response = await this.request(token, "mediaItems", "get", params);
      const data = response.data;

      if (data.mediaItems && Array.isArray(data.mediaItems)) {
        allItems = allItems.concat(data.mediaItems);
      }

      pageToken = data.nextPageToken || null;
    } while (pageToken);

    this.mediaItems = allItems;
    this.lastMediaFetch = Date.now();
    this.log("Retrieved", allItems.length, "picked media items.");
    return allItems;
  }

  /**
   * Get the access token for authenticated baseUrl requests
   * (Picker API baseUrls require Authorization header)
   * @returns {Promise<string>}
   */
  async getAccessToken() {
    const client = await this.onAuthReady();
    return client.credentials.access_token;
  }

  /**
   * Check if baseUrls need refreshing (they expire in 60 minutes)
   * @returns {boolean}
   */
  needsBaseUrlRefresh() {
    // Refresh if older than 50 minutes
    return Date.now() - this.lastMediaFetch > 50 * 60 * 1000;
  }
}

module.exports = GPhotosPicker;
