# MMM-GooglePhotos

A MagicMirror² module to display photos from Google Photos using the official Google Photos Library API.

## Features

- Display photos from specific albums or all photos
- Random or chronological sorting
- Automatic photo rotation
- OAuth 2.0 authentication

## Installation

1. Navigate to your MagicMirror's modules folder:
```bash
cd ~/MagicMirror/modules
```

2. Clone this repository:
```bash
git clone https://github.com/yourusername/MMM-GooglePhotos.git
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

### Step 2: Enable Google Photos Library API

1. In your project, go to **APIs & Services** > **Library**
2. Search for "Photos Library API"
3. Click on it and press **Enable**

### Step 3: Create OAuth 2.0 Credentials

1. Go to **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **OAuth client ID**
3. If prompted, configure the OAuth consent screen:
   - Choose **External** user type
   - Fill in the required fields (app name, user support email, developer email)
   - Add your email as a test user
   - Save and continue through the scopes and summary
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

1. Navigate to the module directory:
```bash
cd ~/MagicMirror/modules/MMM-GooglePhotos
```

2. Run the authentication setup:
```bash
node auth_setup.js
```

3. The script will display a URL. Open it in your browser
4. Sign in with your Google account
5. Grant the requested permissions
6. Copy the authorization code from the browser
7. Paste it into the terminal when prompted
8. You should see "✓ Token stored successfully!"

**Important:** The `token.json` file will be created and contains your access token. Keep this file secure and do not share it.

## Configuration

Add the module to your `config/config.js` file:

```javascript
{
  module: "MMM-GooglePhotos",
  position: "middle_center",
  config: {
    albums: ["Vacation 2024", "Family Photos"], // Leave empty [] for all photos
    updateInterval: 60000, // 60 seconds (in milliseconds)
    sort: "random", // "random" or "time"
    maxWidth: 1920,
    maxHeight: 1080
  }
},
```

### Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `albums` | Array of album names to display. Leave empty for all photos. | `[]` |
| `updateInterval` | Time between photo changes (milliseconds) | `60000` |
| `sort` | Sort order: "random" or "time" | `"random"` |
| `maxWidth` | Maximum photo width in pixels | `1920` |
| `maxHeight` | Maximum photo height in pixels | `1080` |

## File Structure

After setup, your module directory should contain:

```
MMM-GooglePhotos/
├── MMM-GooglePhotos.js
├── auth_setup.js
├── credentials.json
├── node_modules/
├── package.json
└── README.md
```

## Usage

### `albums`

Specify album titles to display photos from specific albums. Leave empty to display photos from all albums.

```js
albums: ["My wedding", "family share", "Travle to Paris", "from Tom"],
```

- Caution. Too many albums and photos could make long bootup delay.
- Remember this. You can only show max 8640 photos in a day. Manage your album what to show, it will make better performance.

### `updateInterval`

- Minimum `updateInterval` is 10 seconds. Too often update could makes API quota drains or network burden.

### `sort`

- `new`, `old`, `random` are supported.

### `maxWidth`, `maxHeight`

- Specify the maximum width and height for the photos in pixels. The module will automatically rotate and resize the photos to fit your display while maintaining the aspect ratio.

## Tip

- Not to show photo info : Add this into your `css/custom.css`.

```css
#GPHOTO_INFO {
  display: none;
}
```

- To move photo info to other position (e.g: top-left corner): Add this into your `css/custom.css`.

```css
#GPHOTO_INFO {
  top: 10px;
  left: 10px;
  bottom: inherit;
  right: inherit;
}
```

- Not to show blurred Background : Add this into your `css/custom.css`.

```css
#GPHOTO_BACK {
  display: none;
}
```

- To cover whole region with image : Add this into your `css/custom.css`.

```css
#GPHOTO_CURRENT {
  background-size: cover;
}
```

- To shrink image and be fully visible on smaller screens : Add this into your `css/custom.css`.

```css
#GPHOTO_CURRENT {
  background-size: contain;
}
```

- To display `clock` more clearly on showing in `fullscreen_below` : Add this into your `css/custom.css`.

```css
.clock {
  padding: 10px;
  background-color: rgba(0, 0, 0, 0.5);
}
```

- To give opacity to photos:

```CSS
@keyframes trans {
  from {opacity: 0}
  to {opacity: 0.5}
}
#GPHOTO_CURRENT {
  background-size:cover;
  opacity:0.5;
}
```

## Notice

- First scanning will take a few (~dozens) seconds. Don't panic.
- If there are 1000s of photos, this scan could take minutes(over 10). longer scans increase the probablity of an error happening. If a single error happens in the scan, it will retry after 1 hour. After first successful scan, subsequent startups should go very quickly(seconds).
