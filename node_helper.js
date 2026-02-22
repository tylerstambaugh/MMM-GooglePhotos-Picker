"use strict";

const fs = require("fs");
const { writeFile, readFile } = require("fs/promises");
const path = require("path");
const NodeHelper = require("node_helper");
const Log = require("logger");
const GP = require("./GPhotos.js");
const authOption = require("./google_auth.json");
const { shuffle } = require("./shuffle.js");
const { error_to_string } = require("./error_to_string");
const { ConfigFileError, AuthError } = require("./Errors.js");

/**
 * @type {GP}
 */
let GPhotos = null;

const NodeHelperObject = {
	start: function () {
		this.config = {};
		/** @type {Array} */
		this.localPhotoList = [];
		this.localPhotoPntr = 0;
		this.lastLocalPhotoPntr = 0;
		this.initializeTimer = null;
		this.pickerSessionId = null;

		this.CACHE_PHOTOS_DIR = path.resolve(this.path, "cache", "photos");
		this.CACHE_METADATA_PATH = path.resolve(this.path, "cache", "pickerMetadata.json");
	},

	socketNotificationReceived: function (notification, payload) {
		switch (notification) {
			case "INIT":
				this.initializeAfterLoading(payload);
				break;
			case "IMAGE_LOAD_FAIL":
				{
					const { url, event, source, lineno, colno, error } = payload;
					this.log_error("[GPHOTO] hidden.onerror", { event, source, lineno, colno });
					if (error) {
						this.log_error("[GPHOTO] hidden.onerror error", error.message, error.name, error.stack);
					}
					this.log_error("Image loading fails. Check your network.:", url);
					this.sendLocalChunk(Math.ceil((20 * 60 * 1000) / this.config.updateInterval));
				}
				break;
			case "IMAGE_LOADED":
				{
					const { id, index } = payload;
					this.log_debug("Image loaded:", `${this.lastLocalPhotoPntr} + ${index}`, id);
				}
				break;
			case "NEED_MORE_PICS":
				{
					this.log_info("Used last pic in list");
					this.sendLocalChunk(Math.ceil((20 * 60 * 1000) / this.config.updateInterval));
				}
				break;
			case "START_PICKER":
				this.startPickerFlow();
				break;
			case "MODULE_SUSPENDED_SKIP_UPDATE":
				this.log_debug("Module is suspended so skip the UI update");
				break;
			default:
				this.log_error("Unknown notification received", notification);
		}
	},

	log_debug: function (...args) {
		Log.debug("[GPHOTOS] [node_helper]", ...args);
	},

	log_info: function (...args) {
		Log.info("[GPHOTOS] [node_helper]", ...args);
	},

	log_error: function (...args) {
		Log.error("[GPHOTOS] [node_helper]", ...args);
	},

	log_warn: function (...args) {
		Log.warn("[GPHOTOS] [node_helper]", ...args);
	},

	initializeAfterLoading: function (config) {
		this.config = config;
		this.debug = config.debug ? config.debug : false;
		GPhotos = new GP({
			authOption: authOption,
			debug: this.debug,
		});

		this.tryToInitialize();
	},

	tryToInitialize: async function () {
		clearTimeout(this.initializeTimer);
		this.initializeTimer = setTimeout(() => {
			this.tryToInitialize();
		}, 3 * 60 * 1000);

		this.log_info("Starting Initialization");

		try {
			// Ensure cache/photos directory exists
			if (!fs.existsSync(this.CACHE_PHOTOS_DIR)) {
				fs.mkdirSync(this.CACHE_PHOTOS_DIR, { recursive: true });
			}

			// Try to load cached photos first for instant display
			const loaded = await this.loadCachedPhotos();

			clearTimeout(this.initializeTimer);
			this.log_info("Initialization complete!");

			if (!loaded) {
				// No cached photos — tell browser to show picker prompt
				this.sendSocketNotification("NO_PHOTOS_CACHED", null);
			}
		} catch (err) {
			if (err instanceof ConfigFileError || err instanceof AuthError) {
				this.sendSocketNotification("ERROR", err.message);
			}
			this.log_error("Initialization failed:", error_to_string(err));
		}
	},

	loadCachedPhotos: async function () {
		if (!fs.existsSync(this.CACHE_METADATA_PATH)) {
			this.log_info("No cached photo metadata found");
			return false;
		}

		try {
			const data = await readFile(this.CACHE_METADATA_PATH, "utf-8");
			const metadata = JSON.parse(data);

			if (!Array.isArray(metadata) || metadata.length === 0) {
				this.log_info("Cached metadata is empty");
				return false;
			}

			// Verify at least some photos still exist on disk
			const existingPhotos = metadata.filter((item) => {
				const filePath = path.resolve(this.path, "cache", "photos", `${item.id}.jpg`);
				return fs.existsSync(filePath);
			});

			if (existingPhotos.length === 0) {
				this.log_info("No cached photo files found on disk");
				return false;
			}

			this.log_info(`Loaded ${existingPhotos.length} cached photos`);
			this.localPhotoList = [...existingPhotos];

			if (this.config.sort === "random") {
				shuffle(this.localPhotoList);
			}

			this.localPhotoPntr = 0;
			this.lastLocalPhotoPntr = 0;

			// Send albums info (single "Selected Photos" album)
			this.sendSocketNotification("INITIALIZED", [{
				id: "picker",
				title: "Selected Photos",
				mediaItemsCount: existingPhotos.length,
			}]);

			// Send first batch of photos
			this.sendLocalChunk(50);
			return true;
		} catch (err) {
			this.log_error("Failed to load cached photos:", error_to_string(err));
			return false;
		}
	},

	startPickerFlow: async function () {
		try {
			this.log_info("Starting Picker flow...");
			this.sendSocketNotification("UPDATE_STATUS", "Creating photo picker session...");

			const session = await GPhotos.createSession();
			this.pickerSessionId = session.id;

			this.log_info("Picker URI:", session.pickerUri);
			this.log_info("Open this URL on your phone or laptop to select photos.");

			// Send the picker URI to the browser for display
			this.sendSocketNotification("PICKER_URI", session.pickerUri);

			// Start polling for user selection
			const pollInterval = session.pollingConfig?.pollInterval
				? parseInt(session.pollingConfig.pollInterval, 10) * 1000
				: 5000;
			const timeoutMs = session.pollingConfig?.timeoutIn
				? parseInt(session.pollingConfig.timeoutIn, 10) * 1000
				: 30 * 60 * 1000; // default 30 min

			await this.pollForSelection(session.id, pollInterval, timeoutMs);
		} catch (err) {
			this.log_error("Picker flow failed:", error_to_string(err));
			this.sendSocketNotification("ERROR", "Failed to start photo picker. Check logs.");
		}
	},

	pollForSelection: async function (sessionId, pollIntervalMs, timeoutMs) {
		const startTime = Date.now();

		const poll = async () => {
			if (Date.now() - startTime > timeoutMs) {
				this.log_warn("Picker session timed out waiting for user selection");
				this.sendSocketNotification("UPDATE_STATUS", "Picker session timed out. Refresh to try again.");
				await GPhotos.deleteSession(sessionId);
				return;
			}

			try {
				const session = await GPhotos.getSession(sessionId);

				if (session.mediaItemsSet) {
					this.log_info("User has selected photos!");
					this.sendSocketNotification("UPDATE_STATUS", "Downloading selected photos...");
					await this.processPickedPhotos(sessionId);
					return;
				}

				this.log_debug("Waiting for user to select photos...");
			} catch (err) {
				this.log_error("Poll error:", error_to_string(err));
			}

			setTimeout(() => poll(), pollIntervalMs);
		};

		await poll();
	},

	processPickedPhotos: async function (sessionId) {
		try {
			const items = await GPhotos.getPickedMediaItems(sessionId);
			this.log_info(`User picked ${items.length} photo(s)`);

			if (items.length === 0) {
				this.log_warn("No photos were selected");
				this.sendSocketNotification("UPDATE_STATUS", "No photos selected. Open picker to try again.");
				return;
			}

			// Download each photo and map to internal format
			const mappedItems = [];
			let downloadCount = 0;

			for (const item of items) {
				try {
					const mapped = await this.downloadAndMapItem(item);
					if (mapped) {
						mappedItems.push(mapped);
						downloadCount++;
						if (downloadCount % 10 === 0) {
							this.sendSocketNotification("UPDATE_STATUS", `Downloaded ${downloadCount}/${items.length} photos...`);
						}
					}
				} catch (err) {
					this.log_error(`Failed to download item ${item.id}:`, error_to_string(err));
				}
			}

			this.log_info(`Downloaded ${mappedItems.length} photos to cache`);

			// Save metadata cache
			await this.writeFileSafe(this.CACHE_METADATA_PATH, JSON.stringify(mappedItems, null, 4), "Picker metadata cache");

			// Set up local photo list
			this.localPhotoList = [...mappedItems];
			if (this.config.sort === "random") {
				shuffle(this.localPhotoList);
			}
			this.localPhotoPntr = 0;
			this.lastLocalPhotoPntr = 0;

			// Notify browser
			this.sendSocketNotification("INITIALIZED", [{
				id: "picker",
				title: "Selected Photos",
				mediaItemsCount: mappedItems.length,
			}]);

			this.sendLocalChunk(50);

			// Clean up session
			await GPhotos.deleteSession(sessionId);
			this.pickerSessionId = null;
		} catch (err) {
			this.log_error("processPickedPhotos failed:", error_to_string(err));
			this.sendSocketNotification("ERROR", "Failed to process picked photos. Check logs.");
		}
	},

	downloadAndMapItem: async function (item) {
		const itemId = item.id;
		const filePath = path.resolve(this.CACHE_PHOTOS_DIR, `${itemId}.jpg`);

		// Skip download if already cached
		if (!fs.existsSync(filePath)) {
			// The Picker API mediaItem has a mediaFile with a baseUrl for download
			const mediaFile = item.mediaFile;
			if (!mediaFile || !mediaFile.baseUrl) {
				this.log_warn(`No download URL for item ${itemId}`);
				return null;
			}

			// Download with OAuth token — Picker API baseUrls require authentication
			const response = await GPhotos.downloadMediaFile(mediaFile.baseUrl);
			fs.writeFileSync(filePath, Buffer.from(response.data));
			this.log_debug(`Downloaded photo: ${itemId}`);
		}

		// Map to internal format compatible with browser code
		const mediaFile = item.mediaFile || {};
		const mediaMetadata = mediaFile.mediaFileMetadata || {};

		return {
			id: itemId,
			baseUrl: `modules/MMM-GooglePhotos/cache/photos/${itemId}.jpg`,
			mediaMetadata: {
				creationTime: item.createTime || new Date().toISOString(),
				width: mediaMetadata.width || "1920",
				height: mediaMetadata.height || "1080",
				photo: mediaMetadata.photo || {},
			},
			_albumId: "picker",
			_albumTitle: "Selected Photos",
		};
	},

	sendLocalChunk: function (desiredChunk = 50) {
		this.log_debug("sendLocalChunk");

		if (this.localPhotoList.length === 0) {
			this.log_warn("No photos in local list to send");
			return;
		}

		if (this.localPhotoPntr < 0 || this.localPhotoPntr >= this.localPhotoList.length) {
			this.localPhotoPntr = 0;
			this.lastLocalPhotoPntr = 0;
		}

		let numToSend = Math.min(desiredChunk, this.localPhotoList.length - this.localPhotoPntr, 50);
		this.log_debug("num to send:", numToSend, ", DesChunk:", desiredChunk, ", totalLength:", this.localPhotoList.length, ", Pntr:", this.localPhotoPntr);

		if (numToSend > 0) {
			let list = this.localPhotoList.slice(this.localPhotoPntr, this.localPhotoPntr + numToSend);

			this.sendSocketNotification("MORE_PICS", list);

			this.lastLocalPhotoPntr = this.localPhotoPntr;
			this.localPhotoPntr = this.localPhotoPntr + list.length;
			this.log_debug("sent:", list.length, ", totalLength:", this.localPhotoList.length, ", Pntr:", this.localPhotoPntr);
		} else {
			this.log_warn("No pics to send");
		}
	},

	stop: function () {
		clearTimeout(this.initializeTimer);
	},

	readFileSafe: async function (filePath, fileDescription) {
		if (!fs.existsSync(filePath)) {
			this.log_warn(`${fileDescription} does not exist: ${filePath}`);
			return null;
		}
		try {
			const data = await readFile(filePath, "utf-8");
			return data.toString();
		} catch (err) {
			this.log_error(`unable to read ${fileDescription}: ${filePath}`);
			this.log_error(error_to_string(err));
		}
	},

	writeFileSafe: async function (filePath, data, fileDescription) {
		try {
			await writeFile(filePath, data);
			this.log_debug(`${fileDescription} saved`);
		} catch (err) {
			this.log_error(`unable to write ${fileDescription}: ${filePath}`);
			this.log_error(error_to_string(err));
		}
	},
};

module.exports = NodeHelper.create(NodeHelperObject);
