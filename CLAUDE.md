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
| `config.js` | Design size, `debug` state, `SEAM_PX`, split-cone strip settings |
| `geometry.js` | Pure math: vectors, angles, capsule tangents, hulls, segment/circle hits, 3D signed distances and root finding |
| `camera.js` | Orbit camera, view basis, projection (`makeProjector`) |
| `scene.js` | `nodes` / `meshes` stores, `createNode` / `createMesh`, the demo scene |
| `shapes.js` | Canvas drawing primitives (capsules, joint disc, split cone, traced pieces) |
| `render.js` | Assembles one frame |
| `splitRing.js` | Split cone geometry in 3D: tangent cone, host solid SDF, `findSplitRing` |
| `jointCurve.js` | Real 3D split of a joint: touch points and the planar joint ring (cone/cone intersection + back circle) |
| `jointSplit.js` | Screen-space terminator from the ring (visible part, clipped to the node circle) |
| `coneDebug.js` | Debug button's cone overlay: split cone ∩ host mesh curves |
| `main.js` | Canvas setup, Pause / Dark mode / Debug buttons, animation loop |

**Frame pipeline (`render`):** project nodes → ownership map (node → meshes) →
joint rings → one primitive per node pair (plus one per joint) → sort
back to front → draw. Consecutive traced primitives of one mesh are batched.

## Concepts
- **Mesh pieces.** Each node pair of a mesh is a *capsule* (two circles joined
  by tangent lines) plus a *fill triangle* from the mesh's projected centroid.
  At a shared node the capsule skips its cap there, and the node circle is
  drawn separately.
- **Joint node** (moon-phase node). A node shared by exactly two 2-node meshes.
  Its disc is divided into two colors by the joint ring (below): the
  *dominant* region, in the nearer mesh's color (`phase` >= 0, from the two
  meshes' camera-space directions, means meshA), and the *crescent*, in the
  other's. The capsules meeting at a joint are plain: they skip their cap there,
  are drawn back to front, and the disc is drawn on top.
- **Joint ring** (`jointCurve.js`, `jointSplit.js`). Each cone of a joint is the
  tangent hull of the node sphere and its far sphere, so it touches the sphere
  along a circle (`u . axis = sinT`). The two circles meet at the **touch
  points**, where the cones touch each other. The color split is one closed ring
  through them, **in a single plane**:
  - two cones tangent to the same sphere intersect in plane conics (Monge), and
    the plane contains both touch points. It does NOT pass through the node
    center unless the cones are equal (3.2% / 8.7% of the radius off at the two
    demo joints); forcing it through the center is what made the ring non-planar
    before. The plane is exact, not fitted: a cone tangent to the sphere
    S = |X-c|^2 - r^2 along the circle L = (X-c).axis - r sinT = 0 satisfies
    S = k L^2 (k constant), so the intersection S = kA LA^2 = kB LB^2 is the pair of
    planes sqrt(kA) LA = +-sqrt(kB) LB. The one that separates the cones (their far
    centers on opposite sides) is the ring's. An earlier fit to marched points swung
    the plane by ~30 degrees for a single frame whenever the marched set changed by
    a few points, and the back arc with it;
  - *front*: the intersection, touch point to touch point, in closed form: each
    generatrix of cone A meets the ring's plane at one point, and those beyond the
    tangent circle, within cone A and on cone B's frustum form the ring (within
    ~1.1-1.3 radii of the node); it ends exactly at the touch points. Computed in
    the flat solid below, recomputed each frame. Marching A's generatrices out of
    B's sdf instead (and taking the longest run) flipped to the other crossing conic
    for single frames when the two were almost equally long (the ring went off
    course, e.g. at 2.904 in the focus view) and lost its ends near the touch points;
  - *back*: where that plane cuts the sphere (a circle through both touch
    points), the stretch around the exposed back (toward `M = -(dA + dB)`);
  - no touch points (arms far apart): the bisector great circle only.
  **Flat solid** (`flatView`, `computeJoints` in `render.js`). The renderer draws
  nodes as flat circles at their own projected radius and cones as the hull of two
  such circles, so the ring is computed in exactly that solid: every node is a
  sphere at (projected x, projected y, z = -depth * the joint node's px per world
  unit) with its projected radius, and the camera looks along -z orthographically.
  The orthographic silhouette of the cones there IS the flat capsules and the
  cone edges (the common tangents of the flat circles), so the ring matches them to the pixel: the back arc stays
  inside the disc (never beyond the rim), the touch points are on the rim, the
  intersection stays within ~0.01 px of every cone outline, and a
  planar ring projects to an exact ellipse. Earlier attempts projected a 3D ring
  in perspective (even with an affine fit to the disc) or blended a billboard
  projection with perspective; none could agree with the flat shapes, leaving a
  bump at the rim and a twist. Trade-off: the curve is recomputed every frame
  (~0.25 ms per joint), not one fixed 3D curve; it differs from the true 3D one by a
  few percent of the radius. Views where no ring point faces the camera (an arm
  pointing at it) give a plain disc.
  Only the part of the ring that faces the camera separates the colors (a
  crease point must face on both cones), so `projectJointSplit` takes the
  longest visible run, clips it to the node circle, and closes the dominant
  region with the rim arc on the dominant mesh's side (the side of the
  terminator that holds that mesh's far node). With no usable run the disc is the
  dominant color. The crescent is drawn at any thickness (below a pixel it
  antialiases to partial coverage and fades in as the ring leaves the rim; the
  dominant region's underlap is clamped to half the crescent so it can't spill
  over the rim). A cutoff at 1 px made a whole 1 px crescent appear at once.
  **Cone bodies stop at the ring.** The ring's plane separates the two cones, so
  the cone on the camera's side of it is the *front* one (`frontIsA` in
  `computeJoints`; this also picks the disc's dominant color). Each cone is drawn
  in its own color as the convex hull (`drawAtJoints`) of its other end's circle
  and, at the joint, the two points where its edges STOP: where the edge touches
  the ring (the contact point, `edgeContacts`, exact) or, if it doesn't, where it meets
  the node's circle. Each edge ends exactly at its stop (any extra hull point, e.g.
  the node's rim, makes the hull join the stop to it with a chord that runs on past
  it as a thin tail). The hull's closing chord between the two stops is routed
  through a point inside both the ring and the node circle (`joint.inner`, the
  touch points' midpoint), so the closing path lies entirely in what is cut out
  next. Two things are then cut out of that hull to get the body's outline
  (`drawJointBody`):
  - the joint's flat node circle (`subtractDisc`, `geometry.js`: the boundary
    outside it plus the circle's own arc, pulled in by the seam underlap so the
    body still reaches under the disc's antialiased rim); the joint disc draws
    that area;
  - the ring's projected interior (`subtractPolygon`, `geometry.js`: the boundary
    outside it plus the ring's own boundary). For the back cone the cut is
    inset by the seam underlap, so it reaches under the front cone's edge along
    the ring (rule 1).
  This applies to every cone arriving at a joint, including a split cone whose far
  end is a joint: its own part (split ring to joint) takes the same body, with the
  split ring's circle in place of the other end (`drawAtJoints` in `render.js`).
  The split ring is projected in perspective but the joint works in the flat model
  (its edges are the tangents of the flat circles), so the ring's points are first
  clamped into the flat capsule and given a copy on each flat tangent line
  (`alignToFlatCone`); otherwise the hull's edge to the contact is slightly off the
  line and runs past the contact as a thin tail. The exact edge/ring contacts are
  hull points too, so the outline leaves each edge at its contact.
  So the outline follows the ring where the ring leaves the node, the flat rim
  elsewhere, and the cone edges to where they touch either. The front cone also
  fills the ring's interior (minus the node disc), in the same path as its body
  (one nonzero fill, rule 3). That interior is the lens where the two cones
  overlap past the disc, and it lies inside the front mesh's silhouette. The back
  cone and the disc are drawn under it; `orderJointBodies` makes sure the front
  body sorts after the back one, split cones included (a split cone keeps its
  layered key, so the other body moves to the right side of it). Without that the
  two bodies, which also overlap a little outside the ring, could paint in the
  wrong order for some angles. No cuts, clips or chords are needed.
  This replaced an older design: a phase-based terminator ellipse, with a seam
  line from the capsules' edge crossing tangent to it driving a capsule cut, a
  seam band and a crescent trim. That needed constant patching of the tangent
  choice (hidden half of the ellipse, thin ellipse near phase 0, straight-through
  joints) and, against a 3D reference, fitted slightly worse (1,463 vs 1,394
  mismatched samples at the orange/yellow joint, 4,518 vs 4,344 at blue/orange);
  dropping it changes at most ~40 sliver pixels per frame.
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
    and the joint disc is drawn after it;
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
2. **A joint's dominant region reaches under the crescent's inner edge, not its
   rim.** The crescent's AA edge then blends over solid color, and the rim isn't
   drawn twice (rule 3). The reach is at most half the crescent.
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
- `drawSplitShared`/`drawSplitFar` sample 128 points per circle and ring, then takes their
  hull. An analytic outline (tangent lines + arcs) would be cheaper and exact.

## Debugging
- The **Debug** button turns all the debug views on and off together
  (`debug.on` in `config.js`, off at load; `debug.gap` / `cone` choose which
  views it shows):
  - gap: paints the background magenta, which makes seam gaps show up;
  - cone (`coneDebug.js`): draws, on top of the frame, where each split cone's
    surface meets its host mesh in 3D (root-found along the cone's
    generatrices): amber = the split ring the split cone uses (dot = where it
    touches the host), blue = true cone ∩ shared sphere, teal = cone ∩ host
    capsules, red = cone ∩ the host's flat faces (planes tangent to three
    spheres), pink = cone ∩ other host spheres. Dotted = buried in the host;
    otherwise solid = near side of the cone, dashed = far side;
- The **Angle** slider at the bottom picks the camera's orbit angle (it pauses the
  orbit; while it runs the slider follows it). Use its value to report an angle.
- The **Focus** button (`focus` in `config.js`, off at load) draws only the meshes
  with the listed colors (orange and yellow), centers the camera on one joint and
  magnifies it, to inspect a joint closely. Everything is still computed with all
  the meshes.
- The **Dark mode** button swaps the background between white and black.
  Light gaps show on black, dark ones on white.
- The browser can't be seen from Claude Code. Geometry is verified with
  headless Node harnesses: the modules are bundled into one script, run in a
  `vm` with a stubbed canvas context, and sampled over the camera orbit. Use a
  point-sampled raster to diff against a reference copy, and a
  coverage-composited rasterizer for AA effects. A refactor should show
  0 differing samples.
