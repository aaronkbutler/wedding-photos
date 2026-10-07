# Wix setup and event rehearsal

1. Add a Photos page to the existing Wix site.
2. Add **Embed a site / HTML iframe** as in the RSVP page.
3. Copy the complete **guest invitation URL** from the photo service's owner page and use that as the embedded website address. Include its `#event=...` fragment. The plain GitHub Pages URL intentionally asks for an album code.
4. Start with a wide desktop frame and at least 900 px height; the photo album supports scrolling and paginated loading. Adjust the separate Wix mobile layout and check that controls remain reachable. The widget does not promise automatic Wix frame resizing.
5. Add a visible **Open photo album in a new tab** link using that same guest URL. The widget also includes this fallback.
6. Point printed QR cards to the final Wix Photos page. If Wix gates the page with a password, confirm guests can reach it at the event. The Wix password alone does not secure the separately hosted app; its guest invitation key protects that entry point.

## Required rehearsal

- Connect Drive and open uploads from the owner page.
- On a phone signed out of Google, upload a photo and a video larger than one upload chunk.
- Verify another unsigned-in guest can view the completed uploads, while partial uploads are not listed.
- Interrupt connectivity mid-upload, restore it, and verify correct resume and intact saved bytes.
- Check Safari and Chrome file pickers, mobile scrolling, video playback or fallback, and downloads inside Wix and in a standalone tab.
- Hide a test item and verify its existing signed media URL stops serving it to guests. Restore it when wanted.
- Check available Drive space, OAuth connection status, and Cloud Run billing/traffic before the wedding.

Originals are stored in the dedicated wedding Drive folder. Keep a verified backup before deleting media. The app's hide control does not delete originals.
