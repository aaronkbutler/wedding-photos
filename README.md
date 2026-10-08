# Wedding Photos

Raquel and Aaron's Wix-embedded wedding album. Guests share original photos and videos, then browse everyone's completed uploads. The interface follows the existing `wedding-rsvps` cream and dusty rose design.

## Hosting

- Static frontend: GitHub Pages, `frontend/` directory.
- Backend: Node.js/Express on Cloud Run, service `wedding-photos-backend`.
- Existing project: `wedding-490801`, region `us-central1`.
- Original files: owner's Google Drive, in an app-created wedding folder.
- Metadata: the project's default Firestore database, `weddingPhotos/event` namespace.
- Credentials: Google Secret Manager; no credentials belong in source, Wix code, or GitHub.

## Development and verification

Node 22 or newer is required.

```sh
cd backend
npm ci
npm test
npm run check
node --test ../frontend/test/upload.test.cjs
```

Serve the frontend with `python3 -m http.server 8787 --directory frontend` from the repository root. Open `http://localhost:8787/?demo=1` for a clearly labeled design preview with uploading disabled. To use the live backend, set its public URL in `frontend/config.js`; the production CORS policy allows the GitHub Pages origin, not arbitrary local origins.

The upload protocol tests cover status reconciliation after lost responses, duplicate chunk retries, file completion, guest/owner separation, hidden media, reservation cleanup, malformed inputs, and Google's HTTP 308 resumable-upload behavior. The live integration script has also verified a generated PNG and 34 MiB MP4 through Google Drive, a second guest session, exact-byte downloads, range playback, thumbnails, and hidden-link revocation. Wix and physical mobile-device verification are still required before event use.

## Provision and deploy

Use the Google Cloud account authorized for `wedding-490801`.

```sh
python3 scripts/provision.py
bash scripts/deploy-backend.sh
```

Provisioning is idempotent. It enables required APIs, creates the default Firestore database if this is the first database, creates a dedicated runtime service account, and generates secrets through stdin. It never prints secret values. Deployment uses request-based Cloud Run billing, no minimum instances, and a two-instance maximum. These are cost controls, not a spending cap.

After deployment, put the returned URL in `frontend/config.js` and publish `frontend/` through GitHub Pages. Do not change the existing RSVP service.

## Connect Google Drive

1. In the same Google Cloud project, create a **Web application** OAuth client named **Wedding Photos**.
2. Set the authorized redirect URI to the exact callback shown on the new service's `/admin` page: `https://YOUR-CLOUD-RUN-URL/api/admin/oauth/callback`.
3. Download the web client JSON. Import it without displaying its secrets:

   ```sh
   python3 scripts/import-oauth.py /absolute/path/to/client.json
   ```

4. Open `/admin` using the owner key stored in the `wedding-photos-admin-key` secret. The local owner-access helper can generate a private handoff file without printing the key.
5. Click **Connect Google Drive** and authorize the configured owner account. The app requests `drive.file`, `openid`, and `email`, verifies the account, and stores the offline refresh token in Secret Manager. It creates its own folder; the original files remain private in Drive.
6. Open uploads, then copy the guest invitation URL for Wix. The fragment contains guest album access, not Google credentials.

The existing Google OAuth project is in **Testing**. Its refresh token can expire in seven days. Public [about](https://aaronkbutler.github.io/wedding-photos/about.html) and [privacy](https://aaronkbutler.github.io/wedding-photos/privacy.html) pages are included for production readiness. Complete the appropriate project publishing configuration or reconnect close to the event, then verify the owner status before guests upload. The project contains other OAuth clients, so review project-wide branding/publishing changes before applying them.

## Guest and owner behavior

- One guest link opens both upload and shared gallery; no guest account is needed.
- Uploads are streamed in 8 MiB chunks, up to 1 GiB per file, with a 100 GiB app collection limit by default.
- The server verifies the final Drive file's size, MIME type, and parent folder before showing success.
- Guests can pause/resume within the open page. Closing the page can require reselecting the files. Uploads are not guaranteed to continue when a phone locks.
- An owner can pause new writes and hide or restore completed items. Hidden originals stay in Drive, but previously downloaded copies cannot be withdrawn.
- Unsupported HEIC/HEVC previews offer an original download. The app does not transcode media.

Gallery media is served through the authorized backend. Cloud Run network traffic can cost money beyond free allowances, which are shared with other workloads. Review real event usage and billing before describing operation as guaranteed free.

See [Wix setup](docs/WIX-SETUP.md) for embed and launch instructions.
