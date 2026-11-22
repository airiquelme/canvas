# gatomica canvas

A renderer of flat shapes rebuilt every frame so they look right from the camera (see `CLAUDE.md` for the design).

```
npm install          # once (Vite only)
npm run dev          # http://localhost:8000, reloads on save
npm run build        # static site in dist/
npm test             # unit tests (tessellation)
npm run check        # illusion renderer regression check (Node)
npm run test:render  # GPU backends vs Canvas 2D, pixel tests in headless Chrome
npm run bench        # frame timings per backend
```

`?backend=webgl2|webgpu|canvas` picks the backend (default: the best the browser runs). `?scene=world|sheets|pairs|patch|shells|basic|full` picks a scene.
