# Doc capture scripts

Two Playwright scripts re-generate the assets used by the help articles.

## Prerequisites

- The Platform Dev workflow must be running (the scripts hit `http://localhost:5000`).
- Headless Chromium needs `libgbm` (already in `replit.nix`).
- The video script needs `ffmpeg` on `PATH` (provided by the Replit runtime).
- One-time browser install: `npx playwright install chromium`.

## Capture screenshots

```
node scripts/capture-doc-screenshots.mjs
```

Writes JPEGs to `client-app/public/docs/screenshots/`. Adjust the
`shots` array at the top of the file to add or change captures. Each
entry navigates to a public route, scrolls to the chosen offset, and
saves a 1280x720 JPEG. The cookie banner is dismissed via an init
script that pre-populates `qvo-cookie-consent-v1` in `localStorage`.

## Record the quickstart walkthrough video

```
node scripts/capture-doc-video.mjs
```

Records a Playwright session as WebM, transcodes to MP4 with ffmpeg
(libx264, yuv420p, faststart), and writes
`client-app/public/docs/videos/quickstart-walkthrough.mp4`.

## Wiring assets into the docs

Reference the new files from `client-app/src/data/docs.ts` using the
`image` or `video` block types — see `DocBlock` in that file and the
matching renderers in `client-app/src/components/DocBlocks.tsx`.
