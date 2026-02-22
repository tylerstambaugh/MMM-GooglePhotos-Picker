//
//
// MMM-GooglePhotos
//
Module.register("MMM-GooglePhotos", {
	defaults: {
		updateInterval: 1000 * 30, // minimum 10 seconds.
		sort: "new", // "old", "random"
		condition: {
			fromDate: null, // Or "2018-03", RFC ... format available
			toDate: null, // Or "2019-12-25",
			minWidth: null, // Or 400
			maxWidth: null, // Or 8000
			minHeight: null, // Or 400
			maxHeight: null, // Or 8000
			minWHRatio: null,
			maxWHRatio: null,
			// WHRatio = Width/Height ratio ( ==1 : Squared Photo,   < 1 : Portraited Photo, > 1 : Landscaped Photo)
		},
		showWidth: 1080, // These values will be used for quality of downloaded photos to show. real size to show in your MagicMirror region is recommended.
		showHeight: 1920,
		timeFormat: "YYYY/MM/DD HH:mm",
		autoInfoPosition: false,
	},
	requiresVersion: "2.24.0",

	suspended: false,

	getStyles: function () {
		return ["MMM-GooglePhotos.css"];
	},

	start: function () {
		this.albums = null;
		this.scanned = [];
		this.updateTimer = null;
		this.index = 0;
		this.needMorePicsFlag = true;
		this.firstScan = true;
		if (this.config.updateInterval < 1000 * 10) this.config.updateInterval = 1000 * 10;
		this.config.condition = Object.assign({}, this.defaults.condition, this.config.condition);

		this.sendSocketNotification("INIT", this.config);
		this.dynamicPosition = 0;
	},

	socketNotificationReceived: function (noti, payload) {
		if (noti === "INITIALIZED") {
			this.albums = payload;
			//set up timer once initialized, more robust against faults
			if (!this.updateTimer || this.updateTimer === null) {
				Log.info("Start timer for updating photos.");
				this.updateTimer = setInterval(() => {
					this.updatePhotos();
				}, this.config.updateInterval);
			}
		}
		if (noti === "MORE_PICS") {
			if (payload && Array.isArray(payload) && payload.length > 0) this.needMorePicsFlag = false;
			this.scanned = payload;
			this.index = 0;
			if (this.firstScan) {
				this.updatePhotos(); //little faster starting
			}
		}
		if (noti === "PICKER_URI") {
			this.showPickerUri(payload);
		}
		if (noti === "NO_PHOTOS_CACHED") {
			let info = document.getElementById("GPHOTO_INFO");
			info.innerHTML = "No photos cached. Click below to select photos.";
			// Automatically start picker flow
			this.sendSocketNotification("START_PICKER", null);
		}
		if (noti === "ERROR") {
			const current = document.getElementById("GPHOTO_CURRENT");
			const errMsgDiv = document.createElement("div");
			errMsgDiv.style.textAlign = "center";
			errMsgDiv.style.lineHeight = "80vh";
			errMsgDiv.style.fontSize = "1.5em";
			errMsgDiv.style.verticalAlign = "middle";
			errMsgDiv.textContent = payload;
			current.appendChild(errMsgDiv);
		}
		if (noti === "CLEAR_ERROR") {
			const current = document.getElementById("GPHOTO_CURRENT");
			current.textContent = "";
		}
		if (noti === "UPDATE_STATUS") {
			let info = document.getElementById("GPHOTO_INFO");
			info.innerHTML = String(payload);
		}
	},

	showPickerUri: function (uri) {
		const current = document.getElementById("GPHOTO_CURRENT");
		current.textContent = "";

		const container = document.createElement("div");
		container.style.textAlign = "center";
		container.style.padding = "20px";
		container.style.display = "flex";
		container.style.flexDirection = "column";
		container.style.alignItems = "center";
		container.style.justifyContent = "center";
		container.style.height = "100%";

		const title = document.createElement("div");
		title.style.fontSize = "1.5em";
		title.style.marginBottom = "20px";
		title.textContent = "Select Photos";

		const instruction = document.createElement("div");
		instruction.style.fontSize = "1em";
		instruction.style.marginBottom = "20px";
		instruction.style.opacity = "0.8";
		instruction.textContent = "Open this URL on your phone or laptop to pick photos:";

		const link = document.createElement("div");
		link.style.fontSize = "0.8em";
		link.style.wordBreak = "break-all";
		link.style.padding = "10px";
		link.style.backgroundColor = "rgba(255,255,255,0.1)";
		link.style.borderRadius = "8px";
		link.style.maxWidth = "80%";
		link.textContent = uri;

		container.appendChild(title);
		container.appendChild(instruction);
		container.appendChild(link);
		current.appendChild(container);

		let info = document.getElementById("GPHOTO_INFO");
		info.innerHTML = "Waiting for photo selection...";
	},

	notificationReceived: function (noti, payload, sender) {
		if (noti === "GPHOTO_NEXT") {
			this.updatePhotos();
		}
		if (noti === "GPHOTO_PREVIOUS") {
			this.updatePhotos(-2);
		}
	},

	updatePhotos: function (dir = 0) {
		Log.debug("Updating photos..");
		this.firstScan = false;

		if (this.scanned.length === 0) {
			this.sendSocketNotification("NEED_MORE_PICS", []);
			return;
		}
		if (this.suspended) {
			this.sendSocketNotification("MODULE_SUSPENDED_SKIP_UPDATE");
			let info = document.getElementById("GPHOTO_INFO");
			info.innerHTML = "";
			return;
		}
		this.index = this.index + dir; //only used for reversing
		if (this.index < 0) this.index = this.scanned.length + this.index;
		if (this.index >= this.scanned.length) {
			this.index -= this.scanned.length;
		}
		let target = this.scanned[this.index];
		// Local files — use baseUrl directly (already a local path)
		let url = target.baseUrl;
		this.ready(url, target);
		this.index++;
		if (this.index >= this.scanned.length) {
			this.index = 0;
			this.needMorePicsFlag = true;
		}
		if (this.needMorePicsFlag) {
			setTimeout(() => {
				this.sendSocketNotification("NEED_MORE_PICS", []);
			}, 2000);
		}
	},

	ready: function (url, target) {
		let hidden = document.createElement("img");
		const _this = this;
		hidden.onerror = (event, source, lineno, colno, error) => {
			const errObj = { url, event, source, lineno, colno, error };
			this.sendSocketNotification("IMAGE_LOAD_FAIL", errObj);
		};
		hidden.onload = () => {
			_this.render(url, target);
		};
		hidden.src = url;
	},

	render: function (url, target) {
		let back = document.getElementById("GPHOTO_BACK");
		let current = document.getElementById("GPHOTO_CURRENT");
		current.textContent = "";
		back.style.backgroundImage = `url(${url})`;
		current.style.backgroundImage = `url(${url})`;
		current.classList.add("animated");
		const info = document.getElementById("GPHOTO_INFO");
		const album = Array.isArray(this.albums) ? this.albums.find((a) => a.id === target._albumId) : { id: -1, title: "" };
		if (this.config.autoInfoPosition) {
			let op = (album, target) => {
				let now = new Date();
				let q = Math.floor(now.getMinutes() / 15);
				let r = [
					[0, "none", "none", 0],
					["none", "none", 0, 0],
					["none", 0, 0, "none"],
					[0, 0, "none", "none"],
				];
				return r[q];
			};
			if (typeof this.config.autoInfoPosition === "function") {
				op = this.config.autoInfoPosition;
			}
			const [top, left, bottom, right] = op(album, target);
			info.style.setProperty("--top", top);
			info.style.setProperty("--left", left);
			info.style.setProperty("--bottom", bottom);
			info.style.setProperty("--right", right);
		}
		info.innerHTML = "";

		// Skip album cover for picker-sourced photos (no album covers available)
		if (album && album.id !== "picker") {
			let albumCover = document.createElement("div");
			albumCover.classList.add("albumCover");
			albumCover.style.backgroundImage = `url(modules/MMM-GooglePhotos/cache/${album.id})`;
			info.appendChild(albumCover);
		}

		let infoText = document.createElement("div");
		infoText.classList.add("infoText");

		if (album && album.title) {
			let albumTitle = document.createElement("div");
			albumTitle.classList.add("albumTitle");
			albumTitle.innerHTML = album.title;
			infoText.appendChild(albumTitle);
		}

		let photoTime = document.createElement("div");
		photoTime.classList.add("photoTime");
		photoTime.innerHTML = this.config.timeFormat === "relative" ? moment(target.mediaMetadata.creationTime).fromNow() : moment(target.mediaMetadata.creationTime).format(this.config.timeFormat);
		infoText.appendChild(photoTime);

		info.appendChild(infoText);
		this.sendSocketNotification("IMAGE_LOADED", { id: target.id, index: this.index });
	},

	getDom: function () {
		let wrapper = document.createElement("div");
		wrapper.id = "GPHOTO";
		let back = document.createElement("div");
		back.id = "GPHOTO_BACK";
		let current = document.createElement("div");
		current.id = "GPHOTO_CURRENT";
		if (this.data.position.search("fullscreen") === -1) {
			if (this.config.showWidth) wrapper.style.width = this.config.showWidth + "px";
			if (this.config.showHeight) wrapper.style.height = this.config.showHeight + "px";
		}
		current.addEventListener("animationend", () => {
			current.classList.remove("animated");
		});
		let info = document.createElement("div");
		info.id = "GPHOTO_INFO";
		info.innerHTML = "Loading...";
		wrapper.appendChild(back);
		wrapper.appendChild(current);
		wrapper.appendChild(info);
		Log.info("updated!");
		return wrapper;
	},

	suspend() {
		this.suspended = true;
	},

	resume() {
		this.suspended = false;
	},
});
