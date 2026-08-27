# Look at the UI

```bash
npm run build          # the gallery reuses the app's compiled Tailwind
bash test/screens/render.sh
```

Writes `test/screens/out/screens.png` — every decorated surface and every state
of the plan badge and quota meter, rendered from the **real components** via
`react-dom/server`, styled with the **real** built stylesheet. No store, no
database, no network.

## Why this exists

Two visual bugs shipped without anyone seeing them, and both were obvious the
moment they were rendered:

- `DecorativeCorner` drew a gradient circle centred in a box pinned to the
  corner, which put its brightest point ~95px *inside* the card — a green
  smudge on top of the body text — with two hairline rings behind it reading
  as a target.
- `EmptyStateIllustration` drew its arrow from x=44 to x=56, straight through
  both of the cards it was meant to connect, and collapsed into a blob at the
  88px it actually renders at.

Neither is visible in a diff. A screenshot caught both in seconds.

## Adding to it

`gallery.jsx` is a plain component tree — add a `<Sec title="…">` whenever a
component gains a state worth eyeballing. Components needing router context
already have `MemoryRouter` around them.

`SCALE` and `SIZE` override the render (`SCALE=2 SIZE=650,800 bash …/render.sh`)
when you want to zoom into one thing.

> Snap-packaged chromium has a **private `/tmp`**, so a `--screenshot` path
> under `/tmp` silently writes nothing. Staging goes through `$HOME` for that
> reason — and not a dot-directory either, which is also blocked.

## Why the renderer forces reduced motion

Pages carry `animate-fade-in`, whose keyframes start at `opacity: 0`. A
screenshot never runs the animation, so without this every capture came out
washed out and unreadable. `--force-prefers-reduced-motion` takes the
`animation: none` branch instead, which is also what a merchant who has asked
for no motion sees — so the screenshot shows a real state, not a workaround.
