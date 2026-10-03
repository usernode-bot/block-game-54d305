# block-game

A shared 3D voxel creative building game, like Minecraft creative mode:
fly around one finite world, place and break blocks picked from a Hotbar
palette, and see what everyone else builds — the world is shared and
persistent.

## How it works

- **The screen** is a full-viewport WebGL scene (`public/index.html` +
  `public/game.js`, rendered with three.js, vendored into
  `public/vendor/` at build time — nothing loads from a CDN at runtime).
- **Controls:** click to capture the mouse (pointer lock); WASD to fly,
  Space/Shift to rise/sink; left-click Places the selected block on the
  aimed face, right-click Breaks; keys 1–8 or the mouse wheel move the
  Hotbar selection. Esc releases the mouse.
- **The world** is one finite area, 128×64×128 cells, seeded with a flat
  grass ground on first boot. No gravity, collisions or survival
  elements — pure creative flying.
- **Sharing:** every place/break is a row in the `blocks` table (an
  upsert-only log — breaks write `type = 'air'` tombstones rather than
  deleting, so no history is destroyed). Clients poll `GET /api/blocks`
  about once a second for changes since their last poll and merge them
  in; there are no websockets.
- **API** (all behind the platform's auth middleware):
  - `GET /api/blocks` — full world dump, or `?since=<ISO timestamp>` for
    just the changes since then. Returns the server's `serverTime`, which
    the client echoes back as its next `since` so clock skew can't skip
    changes.
  - `POST /api/blocks` — `{ x, y, z, type }` with a palette type or
    `'air'`; upserts one cell and records who did it.
- **Styling:** Tailwind, precompiled by `npm run build` during image
  creation. The HUD has a light and a dark look that follow the viewer's
  Homeroom theme; the 3D scene keeps one fixed look of its own.

## Running locally

```sh
npm ci --include=dev
npm run build      # compiles public/tailwind.css + copies three.js to public/vendor/
npm start          # needs DATABASE_URL
```
