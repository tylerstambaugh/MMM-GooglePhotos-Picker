//
//
// MMM-GooglePhotos
//
Module.register("MMM-GooglePhotos", {
  defaults: {
    albums: [],
    updateInterval: 60000, // 60 seconds
    sort: "random", // random, time
    maxWidth: 1920,
    maxHeight: 1080,
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
    this.currentPhoto = null;
    this.uploadableAlbum = null;
    this.albums = null;
    this.scanned = [];
    this.updateTimer = null;
    this.index = 0;
    this.needMorePicsFlag = true;
    this.firstScan = true;
    if (this.config.updateInterval < 1000 * 10) this.config.updateInterval = 1000 * 10;
    this.config.condition = Object.assign({}, this.defaults.condition, this.config.condition);

    const config = { ...this.config };
    for (let i = 0; i < config.albums.length; i++) {
      const album = config.albums[i];
      if (album instanceof RegExp) {
        config.albums[i] = {
          source: album.source,
          flags: album.flags,
        };
      }
    }

    this.sendSocketNotification("INIT", config);
    this.scheduleUpdate();
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "UPLOADABLE_ALBUM") {
      this.uploadableAlbum = payload;
    }
    if (notification === "INITIALIZED") {
      this.albums = payload;
      //set up timer once initialized, more robust against faults
      if (!this.updateTimer || this.updateTimer === null) {
        Log.info("Start timer for updating photos.");
        this.updateTimer = setInterval(() => {
          this.updatePhotos();
        }, this.config.updateInterval);
      }
    }
    if (notification === "UPDATE_ALBUMS") {
      this.albums = payload;
    }
    if (notification === "MORE_PICS") {
      if (payload && Array.isArray(payload) && payload.length > 0) this.needMorePicsFlag = false;
      this.scanned = payload;
      this.index = 0;
      if (this.firstScan) {
        this.updatePhotos(); //little faster starting
      }
    }
    if (notification === "ERROR") {
      const current = document.getElementById("GPHOTO_CURRENT");
      const errMsgDiv = document.createElement("div");
      errMsgDiv.style.textAlign = "center";
      errMsgDiv.style.lineHeight = "80vh";
      errMsgDiv.style.fontSize = "1.5em";
      errMsgDiv.style.verticalAlign = "middle";
      errMsgDiv.textContent = payload;
      current.appendChild(errMsgDiv);
    }
    if (notification === "CLEAR_ERROR") {
      const current = document.getElementById("GPHOTO_CURRENT");
      current.textContent = "";
    }
    if (notification === "UPDATE_STATUS") {
      let info = document.getElementById("GPHOTO_INFO");
      info.innerHTML = String(payload);
    }
    if (notification === 'PHOTO') {
      this.currentPhoto = payload;
      this.updateDom(1000);
    } else if (notification === 'AUTH_REQUIRED') {
      console.error('Authentication required. Please run: node auth_setup.js');
      this.currentPhoto = {error: 'Authentication required'};
      this.updateDom();
    } else if (notification === 'ERROR') {
      console.error('Error:', payload);
      this.currentPhoto = {error: payload};
      this.updateDom();
    } else if (notification === 'NO_PHOTOS') {
      this.currentPhoto = {error: 'No photos found'};
      this.updateDom();
    }
  },

  notificationReceived: function (noti, payload, sender) {
    if (noti === "GPHOTO_NEXT") {
      this.updatePhotos();
    }
    if (noti === "GPHOTO_PREVIOUS") {
      this.updatePhotos(-2);
    }
    if (noti === "GPHOTO_UPLOAD") {
      this.sendSocketNotification("UPLOAD", payload);
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
    let url = target.baseUrl + `=w${this.config.showWidth}-h${this.config.showHeight}`;
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
    //current.classList.remove("animated")
    // let dom = document.getElementById("GPHOTO");
    back.style.backgroundImage = `url(${url})`;
    current.style.backgroundImage = `url(${url})`;
    current.classList.add("animated");
    const info = document.getElementById("GPHOTO_INFO");
    const album = Array.isArray(this.albums) ? this.albums.find((a) => a.id === target._albumId) : { id: -1, title: '' };
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
    let albumCover = document.createElement("div");
    albumCover.classList.add("albumCover");
    albumCover.style.backgroundImage = `url(modules/MMM-GooglePhotos/cache/${album.id})`;
    let albumTitle = document.createElement("div");
    albumTitle.classList.add("albumTitle");
    albumTitle.innerHTML = album.title;
    let photoTime = document.createElement("div");
    photoTime.classList.add("photoTime");
    photoTime.innerHTML = this.config.timeFormat === "relative" ? moment(target.mediaMetadata.creationTime).fromNow() : moment(target.mediaMetadata.creationTime).format(this.config.timeFormat);
    let infoText = document.createElement("div");
    infoText.classList.add("infoText");

    info.appendChild(albumCover);
    infoText.appendChild(albumTitle);
    infoText.appendChild(photoTime);
    info.appendChild(infoText);
    this.sendSocketNotification("IMAGE_LOADED", { id: target.id, index: this.index });
  },

  getDom: function () {
    const wrapper = document.createElement("div");
    wrapper.className = "MMM-GooglePhotos";

    if (!this.currentPhoto) {
      wrapper.innerHTML = "Loading photos...";
      return wrapper;
    }

    if (this.currentPhoto.error) {
      wrapper.innerHTML = `Error: ${this.currentPhoto.error}`;
      return wrapper;
    }

    const img = document.createElement("img");
    img.src = this.currentPhoto.url;
    img.style.maxWidth = this.config.maxWidth + "px";
    img.style.maxHeight = this.config.maxHeight + "px";
    wrapper.appendChild(img);

    return wrapper;
  },

  scheduleUpdate: function () {
    setInterval(() => {
      this.sendSocketNotification("NEXT_PHOTO");
    }, this.config.updateInterval);
  },

  suspend() {
    this.suspended = true;
  },

  resume() {
    this.suspended = false;
  },
});
