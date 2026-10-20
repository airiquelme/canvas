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
| `config.js` | Design size, `debug` state, `SEAM_PX`, `MIN_CRESCENT_PX` |
| `geometry.js` | Pure math: vectors, angles, capsule tangents, hulls, polygon clipping, line/circle and ellipse tangent solvers |
| `camera.js` | Orbit camera, view basis, projection (`makeProjector`) |
| `scene.js` | `nodes` / `meshes` stores, `createNode` / `createMesh`, the demo scene |
| `shapes.js` | Canvas drawing primitives (capsules, joint circle, split cone, traced pieces) |
| `render.js` | Assembles one frame |
| `splitRing.js` | Split cone geometry in 3D: tangent cone, host solid SDF, `findSplitRing` |
| `jointCurve.js` | Real 3D split of a joint: touch points, cone/cone intersection curve, back great circle |
| `jointSplit.js` | Screen-space terminator from that curve (visible part, clipped to the node circle) |
| `jointDebug.js` | Debug button's joint overlay: terminator, crossing and seam (tangent) line at each joint |
| `coneDebug.js` | Debug button's cone overlay: split cone ∩ host mesh curves |
| `main.js` | Canvas setup, Pause / Dark mode / Debug buttons, animation loop |

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
- **Joint curve** (`jointCurve.js`, `jointSplit.js`; `JOINT_FROM_CURVE` in
  `config.js`, false = the phase ellipse). Each cone of a joint is the tangent
  hull of the node sphere and its far sphere, so it touches the sphere along a
  circle (`u . axis = sinT`). The two circles meet at the **touch points**,
  where the cones touch each other. The color split is one closed **planar
  ring**: every point lies in a single plane through the node's center.
  - *front*: the cones' real intersection curve, touch point to touch point
    (found by marching cone A's generatrices against cone B's sdf; it stays
    within ~1.1-1.3 radii of the node), moved into the plane;
  - *back*: the circle where that plane cuts the sphere, from touch point to
    touch point around the exposed back (through `M = -(dA + dB)`, the point
    farthest from both cones);
  - the plane is the least-squares plane through the center fitted to the
    intersection curve, with the touch points weighted so the ring starts at
    them. The intersection is exactly planar only for equal cones: here it is
    off its best plane by 3.9% (blue/orange) and 8.9% (orange/yellow, unequal
    radii) of the radius, so the planar ring stays within ~1-2% of the radius of
    both cone surfaces. Two independently built curves (the circle through the
    touch points, and the intersection) are NOT coplanar: the circle's plane was
    5 degrees off at orange/yellow, and through two nearly opposite touch points
    (small `sinT`) it is undetermined and came out rotated 90 degrees;
  - no touch points (arms far apart): the bisector great circle only.
  Only the part of the ring that faces the camera separates the colors (a
  crease point must face on both cones), so `projectJointSplit` takes the
  longest visible run, clips it to the node circle, and closes the dominant
  region with the rim arc on the dominant mesh's side (the side of the
  terminator that holds that mesh's far node). If there is no usable run (e.g.
  one arm points straight at the camera, phase ~ +-1) the ellipse is used. The
  capsule cut, seam line and crescent trim are still the ellipse-based ones; the
  curve split does not use the trim.
- **Seam line** (`seamLine`). From the crossing, tangent to the terminator
  ellipse, to `rimHit` where it leaves the joint's rim. This line is the front
  mesh's silhouette continued over the joint.
  - **The seam line must be a true tangent: it touches the terminator and
    never enters it.** (`findEllipseTangentPoint`.) Anything that moves the
    point to a non-tangent spot, such as capping it at the ellipse's halfway
    point or at a pole, makes the crescent's edge from the tangent point to the
    rim run through the ellipse: with a halfway cap the line entered the
    ellipse in 131 / 148 frames, up to 99% of its depth.
  - **Wide ellipse: only the half on the crescent's side is a boundary between
    the two colors** (local x >= 0 for phase >= 0, x <= 0 otherwise); the other
    half lies inside the dominant color and can't be seen. Take the tangent on
    that half nearest the crossing. If both tangents touch the hidden half,
    use the pole the crossing faces.
  - **Thin ellipse: take the nearest tangent, on either side.** A collapsed
    ellipse is a line whose two halves coincide, so the visible-half rule
    flips with the sign of the phase: with the crossing slightly off the axis
    it picked the far end of the line on one side of the swap and the near end
    on the other (the crossing-to-tangent distance went 39 -> 80 px as the
    ellipse collapsed, then 17 px after the swap). The nearest tangent moves
    toward the crossing as the ellipse collapses and back out after, about
    17-21 px on both sides. The two rules are blended along the ellipse while
    the half-width goes from 0.02 to 0.08 of the height (a few pixels, so the
    blend is barely off the tangent). Picking the nearest tangent for every
    ellipse is wrong: it lands on the hidden half by > 3 px in half the frames.
  - Tried and rejected: a tolerance that lets the tangent onto the hidden half,
    a blend over a wide phase range, capping at the halfway point (not a
    tangent), and using the halfway point for the all-hidden case (the
    crossing flips poles in a straight-through joint and each side then keeps a
    different quarter of the crescent).
  - `buildTrim` picks the arc direction from the crescent's side, not from the
    sign of an angle that is +-PI when the tangent is at a pole.
  - With the arms exactly collinear the edges don't cross at all (no seam, so
    no cut and a full crescent); the crossing then reappears on the opposite
    pole.
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
  - A capsule that is a joint at both ends (a chain of joints) gets one seam
    and one cut per joint end (`findSeams`). In `drawPairCapsule` one cut that
    lies on an edge redirects the edge path; the others are masked. Before
    this, `findSeam` kept only the longest seam of the pair, so the other
    end's capsule was never cut and its trim/band came from one mesh only.
  - **The cut and the trim must use the same line.** Both go through
    `seamLine`. Every mismatch so far has shown up as a visible bug.
- **Seam band.** The first capsule drawn at a joint fills a SEAM_PX / 2 band
  along the seam line, inside the sliver it removed, before its own fill. The
  upper capsule's AA edge then blends over solid color.
- **Split cone.** A 2-node mesh sharing a node with a 3+ node mesh, drawn by
  `drawSplitShared` / `drawSplitFar`. The cone is the tangent hull of its two spheres, and its
  color changes at a *split ring*: the circle perpendicular to the axis that
  `findSplitRing` (`splitRing.js`) slides out from the shared node until the
  whole circle is clear of the host mesh (spheres, capsules, faces), so it
  touches the host's edge. This is camera-independent.
  - the part from the shared node to the ring takes the host mesh's color;
  - the rest keeps its own color;
  - each part is the convex hull of the projected ring and its end circle,
    except that the shared sphere only counts up to the cone's tangent circle:
    past it the sphere is inside the cone, so its rim points there are left
    out (they would paint host color past the ring when it is edge-on);
  - the host mesh does not draw the split node's disc; the cone owns it;
  - the cone is two primitives, `drawSplitShared` (host color, shared node to
    ring) and `drawSplitFar` (its own color, ring to far node), sorted in
    layers around the host: far parts of cones facing away from the camera,
    then every cone's shared part, then far parts of cones facing it
    ("facing" = camera on the far side of the ring plane). A cone drawn as one
    unit let one cone's green half-disc land on another cone's far part when
    two cones share a host node. Cones facing alike are ordered by how much
    each points at the camera;
  - if the far node is a joint, the far part has no cap there (chord instead)
    and is cut along the joint's seam line like a capsule (`clipOutSliver`),
    and the joint circle is drawn after it;
  - **Strip.** The host's silhouette bulges slightly past the ring plane beside
    the touching point, and the cone's far part is in front of that bulge. A
    per-primitive painter order can't express that, so when the cone is drawn
    before the host and the ring is nearly edge-on (|cos| < `SPLIT_STRIP_MAX_FLAT`),
    `drawSplitStrip` lays a thin far-colored strip (`SPLIT_STRIP_FRAC` of the ring
    radius, minus the ring's ellipse) after the host. Gated because from above
    the host really is in front, and the strip would paint over it.
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
5. **A sphere end of a cone is clipped to its own side of the split plane.**
   Drawing its whole disc paints that color over the other part, worst when
   the split ring is edge-on.

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
- `drawSplitShared`/`drawSplitFar` sample 128 points per circle and ring, then takes their
  hull. An analytic outline (tangent lines + arcs) would be cheaper and exact.
- `findSeamAt` calls `findEdgeCrossing` up to 4 times per pairing (with and
  without `ext`). Computing the raw t/u once would avoid that.

## Debugging
- The **Debug** button turns all the debug views on and off together
  (`debug.on` in `config.js`, off at load; `debug.gap` / `cone` / `joint`
  choose which views it shows):
  - gap: paints the background magenta, which makes seam gaps show up;
  - cone (`coneDebug.js`): draws, on top of the frame, where each split cone's
    surface meets its host mesh in 3D (root-found along the cone's
    generatrices): amber = the split ring the split cone uses (dot = where it
    touches the host), blue = true cone ∩ shared sphere, teal = cone ∩ host
    capsules, red = cone ∩ the host's flat faces (planes tangent to three
    spheres), pink = cone ∩ other host spheres. Dotted = buried in the host;
    otherwise solid = near side of the cone, dashed = far side;
  - joint curve (`jointDebug.js`): touch points (magenta dots), the cones'
    intersection curve (cyan) and the great circle across the back (green);
    solid where it faces the camera, dashed where it faces away;
  - joint (`jointDebug.js`): at each moon-phase joint, the terminator ellipse
    (blue dashed) with the phase, and for each seam at the joint (red, then
    orange) the crossing (white dot), the tangent point (yellow dot), the seam
    line out to where it leaves the rim (colored dot), and the capsule edge's
    own rim point (green dot). A red/orange X is a seam with no usable tangent
    (its cut and trim are dropped).
- The **Dark mode** button swaps the background between white and black.
  Light gaps show on black, dark ones on white.
- The browser can't be seen from Claude Code. Geometry is verified with
  headless Node harnesses: the modules are bundled into one script, run in a
  `vm` with a stubbed canvas context, and sampled over the camera orbit. Use a
  point-sampled raster to diff against a reference copy, and a
  coverage-composited rasterizer for AA effects. A refactor should show
  0 differing samples.
