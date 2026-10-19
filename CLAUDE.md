# Canvas mesh renderer

A Canvas 2D renderer for "meshes" of spherical nodes, viewed by an orbiting 3D
camera. Goal: shared nodes between meshes render cleanly — no antialiasing (AA)
seam gaps, no on-top stroke artifacts, no bulges.

## Run
`npx live-server --port=8000` in this folder (auto-reloads on save), then open
http://localhost:8000. The page uses ES modules, so opening the file directly
(file://) won't work.

## Modules
| File | Contents |
|---|---|
| `config.js` | Design size, `GAP_DEBUG`, `SEAM_PX`, `MIN_CRESCENT_PX` |
| `geometry.js` | Pure math: vectors, angles, capsule tangents, hulls, polygon clipping, line/circle and ellipse tangent solvers |
| `camera.js` | Orbit camera, view basis, projection (`makeProjector`) |
| `scene.js` | `nodes` / `meshes` stores, `createNode` / `createMesh`, the demo scene |
| `shapes.js` | Canvas drawing primitives (capsules, joint circle, split cone, traced pieces) |
| `render.js` | Assembles one frame |
| `main.js` | Canvas setup, Pause / Dark mode buttons, animation loop |

**Frame pipeline (`render`):** project nodes → ownership map (node → meshes) →
joint terminators → one primitive per node pair (plus one per joint) → sort
back to front → draw. Consecutive traced primitives of one mesh are batched.

## Concepts
- **Mesh pieces.** Each node pair of a mesh is a *capsule* (two circles joined
  by tangent lines) plus a *fill triangle* from the mesh's projected centroid.
  At a shared node the capsule skips its cap there, and the node circle is
  drawn separately.
- **Joint node** (moon-phase node). A node shared by exactly two 2-node meshes.
  It's drawn as a split circle (`drawJointSplitCircle`): the *terminator
  ellipse*, with azimuth and `phase` ∈ [-1, 1] taken from the two meshes'
  camera-space directions, divides it into a *dominant* side and a thin
  *crescent* (the farther mesh's color).
- **Edge crossing** (`findEdgeCrossing`). Where one capsule's tangent edge
  crosses the other mesh's edge, both starting at the joint. There are two
  fallbacks:
  - *Short arm:* the crossing lies past one arm's end, so it uses where the
    other edge hits that far node's circle.
  - *Extended:* edge-on views, where the lines only meet past both arms. This
    is a last resort, flagged `extended`. Both capsules must choose the same
    edge pairing, so the nearer crossing wins.
- **Seam line** (`seamLine`). From the crossing, tangent to the terminator
  ellipse, to `rimHit` where it leaves the joint's rim. This line is the front
  mesh's silhouette continued over the joint.
  - `findEllipseTangentPoint` may return a `capped` fallback point, which is
    not a real tangent. Capped points are never used.
- **Crescent trim.** The crescent is cut off at the seam line, so no "tail" of
  it pokes out past the front mesh.
- **Capsule cut.** Each capsule at a joint loses the *sliver* between its own
  edge and the seam line, which lets the other mesh show through there.
  - If the crossing is on the capsule's edge, the edge path is simply
    redirected.
  - Otherwise (short arm, or extended crossing) the sliver is masked out with
    an evenodd clip. For an extended crossing, the mask is limited to the
    other capsule's area, shrunk slightly.
  - A cut is skipped when `rimHit` lands more than 90° around the rim from the
    capsule's edge.
  - **The cut and the trim must use the same line.** Both go through
    `seamLine`. Every mismatch so far has shown up as a visible bug.
- **Seam band.** The first capsule drawn at a joint fills a SEAM_PX / 2 band
  along the seam line, inside the sliver it removed, before its own fill. The
  upper capsule's AA edge then blends over solid color.
- **Split cone.** A 2-node mesh sharing a node with a 3+ node mesh, drawn by
  `drawSplitCone`. Treated as a 3D cone, its cross-section ring sits where the
  axis leaves the shared node's sphere:
  - the part from the shared node to the ring takes the host mesh's color;
  - the rest keeps its own color;
  - each part is the convex hull of the projected ring and its end circle;
  - the part on the camera's side of the ring plane is drawn last.
- **Batching.** Plain pieces (no joint end, not split) are *traced* into one
  path and filled once per run of consecutive same-mesh primitives, as a
  nonzero union. Every subpath must wind anticlockwise on screen.

## Rendering rules (learned the hard way)
1. **Underpaint, never on-top patches.** For a gap between two pieces, the
   lower piece reaches under the upper piece's *inner* edges, never its outer
   edges. Strokes or patches drawn on top create visible steps.
2. **Use a one-sided seam band, not a centered stroke.** A centered stroke
   pokes out where the shapes taper to a point.
3. **Same-color coincident edges bulge.** Two AA edges on the same outline
   stack (`1-(1-α)^n`), so the outline looks thicker and darker. Trace the
   pieces into one path and fill once, and don't refill circles that a cap
   already covers.
4. **No circular clip on the joint.** A clip's AA edge compounds with the
   fill's own edge.

## Known limitations / next
- Shared nodes involving 3+ node meshes, beyond the split cone, aren't
  handled. Joints are limited to exactly two 2-node meshes (`findJointNodeIds`).
- Only the first shared node of a 2-node mesh is split.
- Batching only merges *consecutive* same-mesh primitives in depth order.
- `projectToScreen` flips world y: larger y appears higher on screen.

## Optimization backlog (these change pixels; verify each with the AA sim)
- Drop `drawTriangle`'s 1px same-color stroke. It's an on-top patch (rule 1),
  and the joint capsules still use it.
- Batch joint capsules and the split cone into unions too (rule 3).
- After a masked capsule, the far circle is refilled, which stacks edges on
  that cap. Exclude the far circle from the mask instead.
- `drawSplitCone` samples 128 points per circle and ring, then takes their
  hull. An analytic outline (tangent lines + arcs) would be cheaper and exact.
- `findSeam` calls `findEdgeCrossing` up to 4 times per pairing (with and
  without `ext`). Computing the raw t/u once would avoid that.

## Debugging
- `GAP_DEBUG = true` (`config.js`) paints the background magenta, which makes
  seam gaps show up.
- The **Dark mode** button swaps the background between white and black.
  Light gaps show on black, dark ones on white.
- The browser can't be seen from Claude Code. Geometry is verified with
  headless Node harnesses: the modules are bundled into one script, run in a
  `vm` with a stubbed canvas context, and sampled over the camera orbit. Use a
  point-sampled raster to diff against a reference copy, and a
  coverage-composited rasterizer for AA effects. A refactor should show
  0 differing samples.
