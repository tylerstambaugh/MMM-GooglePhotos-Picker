# MMM-GooglePhotos

A MagicMirror² module to display photos from Google Photos using the **Google Photos Picker API**.

> **Note:** This module uses the [Google Photos Picker API](https://developers.google.com/photos/picker/guides/get-started-picker), which replaced the deprecated Library API (scopes removed March 31, 2025). On first launch, you will be prompted to select photos via a Google-hosted picker. The module then displays those photos in a slideshow.

---

## Features

- Display user-selected photos from Google Photos
- Random, newest-first, or oldest-first sorting
- Automatic base URL refresh (Picker API URLs expire after 60 minutes)
- OAuth 2.0 authentication
- Saved sessions resume on restart (no re-picking needed until session expires)

## Installation

1. Navigate to your MagicMirror's modules folder:
```bash
cd ~/MagicMirror/modules
```

2. Clone this repository:
```bash
git clone https://github.com/hermanho/MMM-GooglePhotos.git
cd MMM-GooglePhotos
```

3. Install dependencies:
```bash
npm install
```

## Getting Google Photos API Credentials

### Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Name it something like "MagicMirror Photos"

### Step 2: Enable the Google Photos Picker API

1. In your project, go to **APIs & Services** > **Library**
2. Search for **"Google Photos Picker API"**
   - **Important:** Do NOT enable the similarly named "Google Picker API" — that is a different API for Drive files. You need the one specifically called **"Google Photos Picker API"**.
3. Click on it and press **Enable**

### Step 3: Create OAuth 2.0 Credentials

1. Go to **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **OAuth client ID**
3. If prompted, configure the OAuth consent screen:
   - Choose **External** user type
   - Fill in the required fields (app name, user support email, developer email)
   - Add scope: `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`
   - Add your email as a test user
   - Save and continue through the summary
4. Back in Credentials, click **Create Credentials** > **OAuth client ID**
5. Choose **Desktop app** as the application type
6. Name it "MMM-GooglePhotos"
7. Click **Create**

### Step 4: Download Credentials

1. Click the download icon (⬇) next to your newly created OAuth 2.0 Client ID
2. Rename the downloaded file to `credentials.json`
3. Move it to the `MMM-GooglePhotos` module directory:
```bash
mv ~/Downloads/client_secret_*.json ~/MagicMirror/modules/MMM-GooglePhotos/credentials.json
```

## Authentication Setup

Generate an OAuth token using the `generate_token_v2.js` script:

1. Navigate to the module directory:
   ```bash
   cd ~/MagicMirror/modules/MMM-GooglePhotos
   ```
2. Ensure your `credentials.json` file is present (see above).
3. Run the token generation script:
   ```bash
   node generate_token_v2.js
   ```
4. A browser window will open for Google authentication. Sign in and approve access.
5. The script saves your token to `token.json`.

> **If you previously used the Library API:** Delete your old `token.json` and re-run `node generate_token_v2.js` to generate a new token with the Picker API scope (`photospicker.mediaitems.readonly`). The old Library API scopes no longer work.

## How the Picker API Works

Unlike the old Library API (which could list all albums/photos automatically), the Picker API requires user interaction:

1. **First launch:** The module creates a Picker session and displays a link on screen.
2. **Select photos:** Open the link on your phone or computer. Google Photos opens and you select the photos you want to display.
3. **Slideshow starts:** Once you confirm your selection, the module downloads and displays your photos.
4. **Session persistence:** The session ID is saved to `picker_session.json`. On restart, the module resumes the saved session without re-picking (until it expires).
5. **Auto-refresh:** Base URLs expire after 60 minutes. The module automatically refreshes them every 50 minutes.
6. **Session expiry:** When a session expires, the module creates a new one and prompts you to pick photos again.

## Configuration

Add the module to your `config/config.js` file:

```javascript
{
  module: "MMM-GooglePhotos",
  position: "middle_center",
  config: {
    updateInterval: 60000, // 60 seconds (in milliseconds)
    sort: "random",        // "random", "new", or "old"
    showWidth: 1080,
    showHeight: 1920,
    debug: false
  }
},
```

### Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `updateInterval` | Time between photo changes (milliseconds). Minimum 10 seconds. | `60000` |
| `sort` | Sort order: `"random"`, `"new"` (newest first), or `"old"` (oldest first) | `"random"` |
| `showWidth` | Photo download width in pixels | `1080` |
| `showHeight` | Photo download height in pixels | `1920` |
| `timeFormat` | Timestamp format (moment.js) or `"relative"` | `"YYYY/MM/DD HH:mm"` |
| `autoInfoPosition` | Auto-rotate info position every 15 min (prevents burn-in) | `false` |
| `debug` | Enable verbose logging | `false` |

> **Note:** The `albums` option from the old Library API is no longer used. With the Picker API, you select photos interactively via the Google-hosted picker.

## File Structure

After setup, your module directory should contain:

```
MMM-GooglePhotos/
├── MMM-GooglePhotos.js       # Frontend module
├── MMM-GooglePhotos.css       # Styles
├── node_helper.js             # Backend (Picker API orchestration)
├── GPhotosPicker.js           # Picker API client
├── credentials.json           # OAuth client credentials (you provide)
├── token.json                 # OAuth token (generated by generate_token_v2.js)
├── picker_session.json        # Saved picker session (auto-created at runtime)
├── google_auth.json           # Auth config (scope, paths)
├── generate_token_v2.js       # Token generation script
├── package.json
├── node_modules/
└── README.md
```

## Tips

- **Hide photo info:** Add to `css/custom.css`:
```css
#GPHOTO_INFO {
  display: none;
}
```

- **Move photo info (e.g. top-left):** Add to `css/custom.css`:
```css
#GPHOTO_INFO {
  top: 10px;
  left: 10px;
  bottom: inherit;
  right: inherit;
}
```

- **Hide blurred background:**
```css
#GPHOTO_BACK {
  display: none;
}
```

- **Cover whole region:**
```css
#GPHOTO_CURRENT {
  background-size: cover;
}
```

- **Contain (shrink to fit):**
```css
#GPHOTO_CURRENT {
  background-size: contain;
}
```

- **Display clock clearly over fullscreen photos:**
```css
.clock {
  padding: 10px;
  background-color: rgba(0, 0, 0, 0.5);
}
```

- **Add opacity to photos:**
```css
@keyframes trans {
  from { opacity: 0 }
  to { opacity: 0.5 }
}
#GPHOTO_CURRENT {
  background-size: cover;
  opacity: 0.5;
}
```

## Resetting the Photo Selection

To choose a new set of photos, delete the saved session file and restart MagicMirror:

```bash
cd ~/MagicMirror/modules/MMM-GooglePhotos
rm picker_session.json
```

Then restart MagicMirror. A new picker session will be created and a fresh link will appear on screen for you to select photos.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "insufficient authentication scopes" | Delete `token.json`, re-run `node generate_token_v2.js`. Ensure **Google Photos Picker API** is enabled in GCP. |
| "No OAuth token found" | Run `node generate_token_v2.js` to generate `token.json`. |
| "Missing credentials.json" | Download OAuth credentials from GCP Console (see Step 4 above). |
| Picker link not working | Ensure you enabled the **Google Photos Picker API** (not "Google Picker API") in GCP. |
| Photos stop loading after ~1 hour | Base URLs expired. The module auto-refreshes every 50 min. If it fails, restart MagicMirror. |
| punycode deprecation warning | Already fixed via npm overrides. Run `npm install` to apply. |
| Want to select different photos | Delete `picker_session.json` and restart MagicMirror (see above). |

## Notice

- On first launch, the module will display a picker link. Open it to select photos.
- Sessions are saved and restored on restart. You only need to re-pick when the session expires.
- The Picker API has usage quotas. For normal slideshow use, you should not hit them.
