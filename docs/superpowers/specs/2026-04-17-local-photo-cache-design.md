# Local Photo Cache — Design

Date: 2026-04-17
Branch: picker-api-migration

## Problem

Google's Picker API replaced the Library API in March 2025. Picker sessions
expire after ~24 hours and cannot be renewed — you have to re-pick photos from
your phone to start a new session. That makes MMM-GooglePhotos unusable as a
long-running slideshow: every day the QR code reappears and you have to scan it
again.

The Picker baseUrls themselves also expire after 60 minutes, so the current
code re-fetches media items every 50 minutes just to refresh them. Once the
underlying session expires, that refresh fails and the module gets stuck.

## Goal

Let MMM-GooglePhotos rotate the same set of picked photos indefinitely without
re-picking. The user should only see the QR code when they actively want to
change their selection.

## Non-goals

- Incremental updates from Google (e.g. picking up new photos added to an album
  after the initial selection). User must re-pick to refresh the set.
- Arbitrary cache size limits or eviction strategies. The cache size is bounded
  by what the user picked.
- Sharing cache between multiple instances of the module.

## Approach

Download each picked photo to disk once, then serve the slideshow from the local
cache forever. Session expiry no longer matters — we only need a live session to
perform the initial download.

### High-level flow

```
start()
  ├─ cache has photos? ──► rotate cache (no API calls, no session needed)
  └─ empty cache ──► show QR code
                    → user picks
                    → eager-download all selected photos
                    → rotate cache
```

The existing 50-minute baseUrl refresh timer is removed entirely. Cached files
don't expire.

## Components

### `PhotoCache.js` (new)

Encapsulates all disk I/O for the cache directory.

**Responsibilities:**
- Track cached photos in memory via an `index.json` file on disk.
- Expose a small API: `list()`, `has(id)`, `add(id, buffer, metadata)`,
  `getPath(id)`, `getMetadata(id)`, `isEmpty()`, `load()`.
- Guarantee that `list()` returns photos in a form the frontend already
  understands (same shape as today's `sendPhotos()` output, but with a local
  URL instead of a Google `baseUrl`).

**On-disk layout:**

```
cache/
├── index.json
├── <mediaItemId>.jpg
├── <mediaItemId>.png
└── ...
```

**`index.json` schema:**

```json
{
  "version": 1,
  "savedAt": 1713340800000,
  "photos": {
    "<mediaItemId>": {
      "filename": "<mediaItemId>.jpg",
      "mimeType": "image/jpeg",
      "creationTime": "2024-08-12T14:30:00Z",
      "width": 1080,
      "height": 1920
    }
  }
}
```

Writing the whole map on each update is fine — the file stays small (few hundred
KB for thousands of photos).

### `node_helper.js` (modified)

Orchestration changes:

**Startup (`initialize`):**
1. Instantiate `PhotoCache`, call `load()`.
2. If cache non-empty: build photo list from cache index, call `sendPhotos()`,
   skip session logic entirely. Done.
3. If cache empty: fall through to existing picker session flow.

**After `pollSession()` returns ready (`fetchAndSendPhotos` becomes
`downloadAndCachePhotos`):**
1. Call `listMediaItems(sessionId)`.
2. Filter to images (same logic as today).
3. For each item where `!cache.has(item.id)`:
   - Download bytes from `baseUrl=wWIDTH-hHEIGHT` (where WIDTH/HEIGHT come from
     `config.showWidth`/`showHeight`) via axios with auth header.
   - Write to `cache/<id>.<ext>` (extension from mime type).
   - Call `cache.add(id, buffer, metadata)`.
   - Send `UPDATE_STATUS` with progress (e.g. "Downloading photo 47/500…").
4. After the loop:
   - Persist `index.json`.
   - Delete `picker_session.json` (no longer needed).
   - Call `sendPhotos()` from cache to start rotation.

**Individual download failures:** log and skip. A handful of failed photos
shouldn't abort the batch. Metadata for failed items is not written to the
index, so they simply won't appear in the rotation.

**Total failure (e.g. all downloads fail, auth dead):** throw out of
`downloadAndCachePhotos`; the existing `initialize` catch will send an ERROR and
retry after 5 minutes.

**Removed:** `startBaseUrlRefresh()` and the `baseUrlRefreshTimer` field.

### Static serving

The browser can't load `file://` paths, but MagicMirror already serves the
`/modules` directory statically via `express.static` (see `js/server.js:108`).
That means files under `cache/` are automatically reachable at
`/modules/modules/MMM-GooglePhotos/cache/<filename>` — no `node_helper` wiring needed.

### `MMM-GooglePhotos.js` (modified)

The frontend `ready()` function becomes much simpler. Cached photos arrive with
a plain URL (no `_accessToken`), so the `fetch + Authorization + Blob` path is
unused.

```js
ready: function (url, target) {
  // Cached photos: load as plain <img> — no auth needed.
  let hidden = document.createElement("img");
  hidden.onerror = () => this.sendSocketNotification("IMAGE_LOAD_FAIL", { url });
  hidden.onload = () => this.render(url, target);
  hidden.src = url;
}
```

The auth-header fetch path is deleted along with `_accessToken` on the photo
object. URLs sent to the frontend look like `/modules/MMM-GooglePhotos/cache/<id>.jpg`.
Since images are already downloaded at display resolution, no `=w…-h…` size
suffix is needed — the existing suffix concatenation in `updatePhotos()` must
be removed.

### `sendPhotos()` changes

Source changes from in-memory `mediaItems` to `photoCache.list()`. The sort
logic (random / old / new based on creationTime) is identical. The transform
that builds the frontend payload drops `_accessToken` and `_albumId`, and sets
`baseUrl` to the local URL.

### `.gitignore`

The existing `.gitignore` already ignores all cache contents via `cache/*` with
a `!cache/keep.txt` exception. No changes needed — downloaded images and
`index.json` are covered.

## Testing

Manual smoke test:
1. Delete `cache/` contents and `picker_session.json`, start MagicMirror.
2. Scan QR code, pick a small selection (5–10 photos), tap Done.
3. Confirm status shows "Downloading photo X/N…" progress.
4. Confirm rotation starts once downloads finish.
5. Inspect `cache/` — files present, `index.json` populated.
6. Confirm `picker_session.json` has been deleted.
7. Restart MagicMirror — rotation starts instantly, no QR code, no network
   activity to photospicker.googleapis.com.
8. Wait past session expiry (or tamper with a leftover `picker_session.json`
   setting `expireTime` to the past) — rotation continues unaffected.
9. Delete `cache/` contents, restart — QR code reappears as expected.

## Migration

Existing users on `picker-api-migration` branch: on their next restart, their
empty `cache/` directory triggers the one-time eager download flow. No manual
migration steps required.

## Out of scope (future possibilities)

- Incremental "add new photos" flow (would need a way to detect new media items
  without full re-pick — not supported by Picker API).
- Trigger re-pick via MagicMirror notification (rejected in favour of
  delete-cache-and-restart for simplicity).
- Cache size budgets / LRU eviction.
