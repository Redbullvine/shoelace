# Shoelace (Phase 1)

Mobile-first PWA-style warehouse companion for scanning telecom inventory. Capture photos, add a location tag, and sync for mock analysis when online.

## Features
- Offline-first capture with local IndexedDB storage
- Draft workflow for multi-photo scans
- Manual label override per photo
- Queue + sync to Netlify function when online
- Result display with confidence-based status
- CSV export for saved scans

## Image to EPS converter
`convert.html` turns PNG, JPEG, WebP, GIF, TIFF or BMP images into vector EPS for embroidery digitizing. The tracing runs server-side in the `convert-to-eps` Netlify function (`/api/convert-to-eps`):

1. Resample to a fixed working size (small logos are upscaled so edges trace smoothly; JPEG noise is median-filtered).
2. Learn the palette in OKLab from flat (non-edge) pixels, then add colors for thin details such as small text.
3. Assign anti-aliased edge pixels to the neighboring region colors, clean specks, and drop the border-connected background.
4. Trace each color layer with Potrace into Bezier curves and write EPS using only core PostScript operators (`moveto`, `curveto`, `fill`), so Wilcom, Hatch, Pulse and Illustrator can open it.

Options: colors (auto or 2-16), detail, corner sharpness, layering (slight overlap, stacked, cutouts) and background removal.

Run the converter tests with `npm install && npm test`.

## Local run
Use any static file server for the inventory pages (no build step required). The converter needs the Netlify function, so use `netlify dev` for it:

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

## Mobile Notes
### iOS Photo Upload
On iPhone, photo uploads use the system chooser (Camera or Photo Library). This is intentional and achieved by omitting the `capture` attribute on the file input.

## Notes
- `/api/analyze-scan` returns mock telecom inventory analysis.
- Ready for Phase 2: real vision OCR + pricing sources.
