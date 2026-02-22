"use strict";

const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");
const { mkdirp } = require("mkdirp");
const { OAuth2Client } = require("google-auth-library");

/**
 * @type {import("axios").AxiosStatic}
 */
const Axios = require("axios");
const { error_to_string } = require("./error_to_string");
const { ConfigFileError, AuthError } = require("./Errors");

/**
 *
 * @param {number} ms ms
 */
function sleep(ms = 1000) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

class Auth extends EventEmitter {
	#config;
	#debug = {};

	constructor(config, debug = false) {
		super();
		this.#config = config;
		this.#debug = debug;
		this.init().then(
			() => { },
			(err) => this.emit("error", err),
		);
	}

	async init() {
		const log = this.#debug
			? (...args) => {
				console.log("[GPHOTOS:AUTH]", ...args);
			}
			: () => { };
		if (this.#config === undefined) this.#config = {};
		if (this.#config.keyFilePath === undefined) {
			throw new ConfigFileError('Missing "keyFilePath" from config (This should be where your Credential file is)');
		}
		if (this.#config.savedTokensPath === undefined) {
			throw new ConfigFileError('Missing "savedTokensPath" from config (this should be where your OAuth2 access tokens will be saved)');
		}
		let file = path.resolve(__dirname, this.#config.savedTokensPath);
		if (!fs.existsSync(file)) {
			throw new AuthError("No OAuth token genreated. Please execute generate_token_v2.js before start.");
		}
		let creds = path.resolve(__dirname, this.#config.keyFilePath);
		if (!fs.existsSync(creds)) {
			throw new AuthError("Missing Credentials.");
		}
		const key = require(this.#config.keyFilePath).installed;
		const oauthClient = new OAuth2Client(key.client_id, key.client_secret, key.redirect_uris[0]);
		let tokensCred;
		const saveTokens = async (first = false) => {
			oauthClient.setCredentials(tokensCred);
			let expired = false;
			if (tokensCred.expiry_date < Date.now()) {
				expired = true;
				log("Token is expired.");
			}
			if (expired || first) {
				const tk = await oauthClient.refreshAccessToken();
				tokensCred = tk.credentials;
				let tp = path.resolve(__dirname, this.#config.savedTokensPath);
				await mkdirp(path.dirname(tp));
				fs.writeFileSync(tp, JSON.stringify(tokensCred));
				log("Token is refreshed.");
				this.emit("ready", oauthClient);
			} else {
				log("Token is alive.");
				this.emit("ready", oauthClient);
			}
		};

		process.nextTick(() => {
			if (this.#config.savedTokensPath) {
				try {
					let file = path.resolve(__dirname, this.#config.savedTokensPath);
					if (fs.existsSync(file)) {
						const tokensFile = fs.readFileSync(file);
						tokensCred = JSON.parse(tokensFile);
					}
				} catch (error) {
					console.error("[GPHOTOS:AUTH]", error);
				} finally {
					if (tokensCred !== undefined) saveTokens();
				}
			}
		});
	}
}

class GPhotos {
	constructor(options) {
		this.debug = false;
		if (!options.hasOwnProperty("authOption")) {
			throw new Error("Invalid auth information.");
		}
		this.options = options;
		this.debug = options.debug ? options.debug : this.debug;
	}

	log(...args) {
		console.info("[GPHOTOS:CORE]", ...args);
	}

	logError(...args) {
		console.error("[GPHOTOS:CORE]", ...args);
	}

	logTrace(...args) {
		console.trace("[GPHOTOS:CORE]", ...args);
	}

	/**
	 *
	 * @returns {Promise<OAuth2Client>} OAuth2Client
	 */
	async onAuthReady() {
		let auth = null;
		try {
			auth = new Auth(this.options.authOption, this.debug);
		} catch (e) {
			this.log(e.toString());
			throw e;
		}
		return new Promise((resolve, reject) => {
			auth.on("ready", (client) => {
				resolve(client);
			});
			auth.on("error", (error) => {
				reject(error);
			});
		});
	}

	async request(token, endPoint = "", method = "get", params = null, data = null) {
		let url = endPoint;
		try {
			let config = {
				method: method,
				url: url,
				baseURL: "https://photospicker.googleapis.com/v1/",
				headers: {
					Authorization: `Bearer ${token}`,
				},
			};
			if (params) config.params = params;
			if (data) config.data = data;
			const ret = await Axios(config);
			return ret;
		} catch (error) {
			this.logTrace("request fail with URL", url);
			this.logTrace("params", JSON.stringify(params));
			this.logTrace("data", JSON.stringify(data));
			this.logError(error_to_string(error));
			throw error;
		}
	}

	/**
	 * Creates a new Picker session.
	 * @returns {Promise<{id: string, pickerUri: string, pollingConfig: object, mediaItemsSet: boolean}>}
	 */
	async createSession() {
		const client = await this.onAuthReady();
		let token = client.credentials.access_token;
		let response = await this.request(token, "sessions", "post", null, {});
		return response.data;
	}

	/**
	 * Gets the current state of a Picker session.
	 * @param {string} sessionId
	 * @returns {Promise<{id: string, pickerUri: string, pollingConfig: object, mediaItemsSet: boolean}>}
	 */
	async getSession(sessionId) {
		const client = await this.onAuthReady();
		let token = client.credentials.access_token;
		let response = await this.request(token, `sessions/${sessionId}`, "get");
		return response.data;
	}

	/**
	 * Fetches all media items picked by the user in a session (paginated).
	 * @param {string} sessionId
	 * @returns {Promise<Array>} Array of picked media items
	 */
	async getPickedMediaItems(sessionId) {
		const client = await this.onAuthReady();
		let token = client.credentials.access_token;
		let allItems = [];
		let pageToken = "";

		do {
			let params = {
				sessionId: sessionId,
				pageSize: 100,
			};
			if (pageToken) params.pageToken = pageToken;

			let response = await this.request(token, "mediaItems", "get", params);
			let body = response.data;

			if (body.mediaItems && Array.isArray(body.mediaItems)) {
				allItems = allItems.concat(body.mediaItems);
			}

			pageToken = body.nextPageToken || "";
			if (pageToken) await sleep(500);
		} while (pageToken);

		return allItems;
	}

	/**
	 * Downloads a media file from a URL that requires OAuth authentication.
	 * @param {string} url The baseUrl from a Picker media item
	 * @returns {Promise<import("axios").AxiosResponse>} Response with arraybuffer data
	 */
	async downloadMediaFile(url) {
		const client = await this.onAuthReady();
		let token = client.credentials.access_token;
		try {
			const response = await Axios({
				method: "get",
				url: url,
				headers: {
					Authorization: `Bearer ${token}`,
				},
				responseType: "arraybuffer",
			});
			return response;
		} catch (error) {
			this.logError("downloadMediaFile failed for URL:", url);
			this.logError(error_to_string(error));
			throw error;
		}
	}

	/**
	 * Deletes a Picker session (cleanup).
	 * @param {string} sessionId
	 */
	async deleteSession(sessionId) {
		try {
			const client = await this.onAuthReady();
			let token = client.credentials.access_token;
			await this.request(token, `sessions/${sessionId}`, "delete");
		} catch (error) {
			this.logError("Failed to delete session:", error_to_string(error));
		}
	}
}

module.exports = GPhotos;
