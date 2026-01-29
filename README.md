# Shoelace (Phase 1)

Mobile-first PWA-style warehouse companion for scanning telecom inventory. Capture photos, add a location tag, and sync for mock analysis when online.

## Features
- Offline-first capture with local IndexedDB storage
- Draft workflow for multi-photo scans
- Manual label override per photo
- Queue + sync to Netlify function when online
- Result display with confidence-based status
- CSV export for saved scans

## Local run
Use any static file server (no build step required):

```powershell
# From c:\Projects\Shoelace
python -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

## Netlify deploy
1) Create a new Netlify site and point it at this folder.
2) Build settings:
   - Build command: (leave empty)
   - Publish directory: `.`
3) Netlify Functions are already configured in `netlify.toml`.

## Test checklist
- Capture 1 wide + 2 close photos in New Scan
- Draft thumbnails render and can delete
- Review screen persists location + notes
- Manual part number increases confidence in results
- Submit while offline -> queued status
- Go online -> queue syncs -> results populate
- Export CSV from Saved Scans

## Notes
- `/api/analyze-scan` returns mock telecom inventory analysis.
- Ready for Phase 2: real vision OCR + pricing sources.
