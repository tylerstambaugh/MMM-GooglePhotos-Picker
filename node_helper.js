const NodeHelper = require("node_helper");
const {google} = require('googleapis');
const fs = require('fs');
const path = require('path');

module.exports = NodeHelper.create({
  start: function() {
    this.albums = [];
    this.photos = [];
    this.index = 0;
    this.oauth2Client = null;
  },

  socketNotificationReceived: function(notification, payload) {
    if (notification === 'INIT') {
      this.config = payload;
      this.authenticate();
    } else if (notification === 'NEXT_PHOTO') {
      this.sendNextPhoto();
    }
  },

  authenticate: async function() {
    try {
      const credentials = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'credentials.json')));
      const {client_secret, client_id, redirect_uris} = credentials.installed || credentials.web;
      
      this.oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
      
      const tokenPath = path.resolve(__dirname, 'token.json');
      if (fs.existsSync(tokenPath)) {
        const token = JSON.parse(fs.readFileSync(tokenPath));
        this.oauth2Client.setCredentials(token);
        this.loadPhotos();
      } else {
        console.log('No token found. Please run authentication setup.');
        this.sendSocketNotification('AUTH_REQUIRED', {
          authUrl: this.getAuthUrl()
        });
      }
    } catch (error) {
      console.error('Authentication error:', error);
      this.sendSocketNotification('ERROR', error.message);
    }
  },

  getAuthUrl: function() {
    const SCOPES = ['https://www.googleapis.com/auth/photoslibrary.readonly'];
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
    });
  },

  loadPhotos: async function() {
    try {
      const photosLibrary = google.photoslibrary({version: 'v1', auth: this.oauth2Client});
      
      if (this.config.albums && this.config.albums.length > 0) {
        await this.loadFromAlbums(photosLibrary);
      } else {
        await this.loadAllPhotos(photosLibrary);
      }
      
      this.sendNextPhoto();
    } catch (error) {
      console.error('Error loading photos:', error);
      this.sendSocketNotification('ERROR', error.message);
    }
  },

  loadFromAlbums: async function(photosLibrary) {
    this.photos = [];
    
    for (const albumName of this.config.albums) {
      const albumsResponse = await photosLibrary.albums.list({pageSize: 50});
      const album = albumsResponse.data.albums?.find(a => a.title === albumName);
      
      if (album) {
        const searchResponse = await photosLibrary.mediaItems.search({
          albumId: album.id,
          pageSize: 100
        });
        
        if (searchResponse.data.mediaItems) {
          this.photos.push(...searchResponse.data.mediaItems.filter(item => 
            item.mimeType && item.mimeType.startsWith('image/')
          ));
        }
      }
    }
    
    this.shufflePhotos();
  },

  loadAllPhotos: async function(photosLibrary) {
    const response = await photosLibrary.mediaItems.list({
      pageSize: 100
    });
    
    this.photos = response.data.mediaItems?.filter(item => 
      item.mimeType && item.mimeType.startsWith('image/')
    ) || [];
    
    this.shufflePhotos();
  },

  shufflePhotos: function() {
    if (this.config.sort === 'random') {
      for (let i = this.photos.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.photos[i], this.photos[j]] = [this.photos[j], this.photos[i]];
      }
    }
    this.index = 0;
  },

  sendNextPhoto: function() {
    if (this.photos.length === 0) {
      this.sendSocketNotification('NO_PHOTOS', {});
      return;
    }
    
    const photo = this.photos[this.index];
    const photoUrl = `${photo.baseUrl}=w${this.config.maxWidth || 1920}-h${this.config.maxHeight || 1080}`;
    
    this.sendSocketNotification('PHOTO', {
      url: photoUrl,
      description: photo.description || '',
      timestamp: photo.mediaMetadata?.creationTime
    });
    
    this.index = (this.index + 1) % this.photos.length;
    
    if (this.index === 0 && this.config.sort === 'random') {
      this.shufflePhotos();
    }
  }
});
