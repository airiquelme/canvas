# Canvas mesh renderer

A Canvas 2D renderer for "meshes" of spherical nodes, viewed by an orbiting 3D
camera. Goal: shared nodes between meshes render cleanly — no antialiasing (AA)
seam gaps, no on-top stroke artifacts, no bulges.

## Notification sound
The project hooks (`.claude/settings.json`) play a Windows sound when Claude stops (Stop: Asterisk) or needs input (Notification:
Exclamation). If they are missing or silent in a session, tell the user (they may need to open `/hooks` once to reload) instead of
working around it. Do not remove them.

## Run
`npx live-server --port=8000` in this folder (auto-reloads on save), then open
http://localhost:8000. The page uses ES modules, so opening the file directly
(file://) won't work.

## Working preferences
Keep verification minimal: check that the code loads and runs (an import / compile check, or one headless
frame with no NaN or exceptions) and stop there. Leave the visual checks to the user, who can judge them at a
glance in seconds, or run them only when asked. Do not build or run raster / ground-truth comparisons, long
orbit sweeps or timing studies on your own initiative (a single 3D-reference run took the better part of 30
minutes); the tools in `tools/` are for when the user asks for them. This overrides the "verify with the AA
sim" notes elsewhere in this file.

## Modules
| File | Contents |
|---|---|
| `config.js` | Design size, `debug` state, `SEAM_PX`, focus view |
| `geometry.js` | Pure math: vectors, angles, capsule tangents, hulls, segment/circle hits, 3D signed distances and root finding; node shapes (spheroid `Q`, `ex` / `ux` principal frame, `ellipsoidShape`); exact ellipse math: tangents from a point (`pointEllipseTangents`) and common tangents of two ellipses (`ellipseTangentAngles`, a quartic), the hull of ellipses / arcs / polygons as an outline (`hullOutline`, `outlinePolygon`, `ellipsePolygon`) and the exact ellipse of a projected circle (`projectedCircleEllipse`) |
| `camera.js` | Orbit camera, view basis, projection (`makeProjector`) |
| `scene.js` | `nodes` / `meshes` stores, `createNode` / `createMesh`, the demo scene |
| `shapes.js` | Canvas drawing primitives (capsules, joint disc, split cone, traced pieces) |
| `render.js` | Assembles one frame |
| `splitRing.js` | Split cone geometry in 3D: tangent cone, host first contact (`findSplitRing`; `findGeneralSplitRing` when a node is squashed), host SDF (debug) |
| `jointCurve.js` | Real 3D split of a joint: touch points and the planar joint ring (cone/cone intersection + back circle) |
| `jointSplit.js` | Screen-space terminator from the ring (visible part, clipped to the node circle) |
| `coneDebug.js` | Debug button's cone overlay: split cone ∩ host mesh curves |
| `jointDebug.js` | Debug button's joint overlay: joint rings, touch points, cone edge stops |
| `hullCone.js` | Cone between two nodes (spheroids or the flat solid's general ellipsoids) as the boundary of the hull of their bodies, from support functions: generatrices (`buildHullCone`), axial cross-section (`crossSection`), signed distance to the hull with its surface normal (`hullSigned`, `hullProbe`) |
| `jointCurveGeneral.js` | The joint ring for joints with a squashed node (`buildJointCurveGeneral`, `edgeContactsGeneral`): same result shape as `jointCurve.js`, from hull cones instead of closed forms |
| `hostHull.js` | A split cone's host mesh as the convex hull of its node bodies (hosts with squashed nodes): exact signed distance (`hostProbe`): a table of 4096 normals only says which bodies are in play, then the candidates (each body's nearest-point normal, each pair's ruled curve, each triple's face normal) are evaluated with the true support |
| `shapeDebug.js` | Debug button's overlay: dotted screen outline of every node (+ cut and axes of squashed ones); a skew node shows instead the body's cross-section at that point of the arch (`sectionAt`, `skew.js`) |
| `main.js` | Canvas setup, Pause / Dark mode / Debug buttons, animation loop |
| `tools/` | Headless Node checks (copy the modules first, they need `"type":"module"`): `trace.mjs` records the canvas calls over the orbit to diff two copies (`SPHERES=1` makes every node round), `shapeCheck.mjs` spheroid math, `hullCheck.mjs` ellipse capsule vs brute-force hull, `orientCheck`/`perspectiveCheck`/`silhouetteCheck` node ellipses vs the 3D body, `coneCheck.mjs` / `ellipsoidCheck.mjs` `hullCone.js` vs the sphere cone and a brute-force hull, `jointParity.mjs` the general joint ring with spheres vs the closed form, `jointCheck.mjs` its invariants and timing on squashed bodies, `jointSweep.mjs` frame-to-frame continuity of the demo's joint over the orbit, `jointRef.mjs` painted colors of a squashed V vs an exact ray cast of its flat solid (`STEP=4 node tools/jointRef.mjs <dir> all 6 <png-prefix>` writes drawn | reference | mismatch images), `meshCheck.mjs` rasterizes the squashed meshes' fills in real frames and compares them with the hull of their node ellipses, `outlineCheck.mjs` the exact ellipse / outline / conic math against brute force, `hostCheck.mjs` `hostProbe` against a brute-force hill climb, `splitCheck.mjs` the uniform closed form and the numeric split ring against each other and the sphere closed form, `frameTime.mjs` ms per `render()` of the demo (`SPHERES=1`: all round) |

## Skewed meshes
`createMesh([a, b], color, { skew: nodeId })` bends a 2-node mesh through a third node (`skew.js`, `buildSkewPrimitives` in
`render.js`). The skew node is only a point: its radius and shape are ignored. The path is the ellipse with conjugate
semi-diameters `(B - A) / 2` and `S - M`, so S is the apex even when off-center. The cross-section comes from the two end nodes
only: each end's `shape.Q` is written in the arch's moving frame (tangent, in-plane normal, plane normal), the two forms are
mixed with a smoothstep and turned back (`shapeAt`); the whole ellipsoid is swept, so a flat end's extent along the arch makes the band bulge where the arch bends. That is intended: sweeping only the cross-section (tried) leaves the ribbon drifting off the flat end discs, so the arch must start and end on the nodes' own shapes. The Debug view's section (`sectionAt`) is the true cut perpendicular to the arch, so it differs from the drawn bulge. So thickness and width are kept along the arch (no swelling from mixing
differently oriented shapes in world coordinates). All-round ends use the circle path with a smoothstep radius. On screen the body
is the union of capsules between consecutive projected circles / ellipses (`archSamples`, refined until in-between ones lie inside
their neighbors' capsule; `traceEllipseCapsule` for squashed ends), traced into one nonzero path. v1 limits: plain meshes only
(skewed meshes are left out of `buildOwnership`, so no joints or split cones), two primitives split at the skew node
(`buildSkewPrimitives`, overlapping by one sample past the apex on each side so a ribbon's two halves have no seam, `slice: null`, key = the mean sample depth of each half), box-only overlap tests.
Scenes: `?scene=basic` (default, `buildBasicScene`) and `?scene=full` (`buildFullScene`, the squashed demo).

## Squashed nodes
A node is a spheroid: `createNode(center, radius, { squash, axis })`; `node.shape` (`makeShape`,
`geometry.js`) has semi-axis `radius * squash` along `axis` and `radius / sqrt(squash)` across (same volume).
`projectNode` gives its screen shadow `ellipse` `{a, b, angle}` (closed form, `shadowEllipse`) and `round`
(true for squash === 1, which keeps every circle code path bit-identical). Supported so far: **plain
pieces only** (`buildPairPrimitive`'s `tracePath`): the capsule is the hull of the two ellipses
(`ellipseHullArcs` finds where the support functions cross; `traceEllipseCapsule` draws the arcs and
common tangents). The Debug overlay (`shapeDebug.js`) also draws the shape's **cut**: the fixed 3D
meridian ellipse through both poles (semi-axes `ra` along `axis`, `rp` along `shape.cutDir`, a direction
across the axis, default world +x; `createNode`'s `cut` option picks another). `projectNode` returns it as
`cut`; unlike the rendered silhouette it collapses to a line when its plane is edge-on (orange; the
silhouette is dashed purple). Both are projected with the projection's Jacobian at the node (`projectNode`),
a linear map: a node off the view axis shows its top or underside, and the shapes stay exact ellipses with
no lens distortion (the cut always lies inside the silhouette). Spheres keep the plain camera basis, so
they stay circles.

**Joints with squashed nodes** (`computeJoints`, `render.js`). If any of a joint's three nodes is
squashed, its ring is the general one (`jointCurveGeneral.js`); all-round joints keep the closed form
(bit-identical output). The flat solid gives each node an ellipsoid (`ellipsoidShape`, `flatBody`): its
projected ellipse as the shadow along z (so the orthographic silhouette is exactly what is drawn) and the
body's own half-extent along the view (`zRadius`) as the third axis. Cones are `hullCone.js` hulls of the
joint body and each far body. The ring is not planar any more:
- touch points: the normals where both cones touch the joint body (hN = hFA = hFB), found on A's contact curve
  (azimuth psi) where hFB - hN changes sign; the front arc of psi is the one with hFB > hN (A's generatrix
  starts inside hull B there);
- front: per psi, the point where A's generatrix leaves hull B. `hullSigned` is convex along a line, so Newton
  from the far end converges monotonically (slope = probe normal . direction). 31 exact points
  (cosine-spaced, warm-started), a cubic Hermite spline through them, and an exact point added wherever the
  spline's midpoint is off by more than half the chord tolerance, then chords within `tol`;
- back: the plane through both touch points and the centroid of the exact front points cuts the joint
  ellipsoid in an ellipse (computed on the unit sphere `Sinv (x - c)`); the stretch through the back is the
  back arc. `curve.plane` is that plane (used for `frontIsA`);
- edge stops: the silhouette generatrices (n.z = 0) cross the other hull at the contact when their azimuth is in
  the ring's arc.
The 2D side of a squashed joint node works in a *unit-circle space* (`ellipseUnitMap`): the screen ellipse is
mapped by a linear map to a circle of radius b (the long axis shrunk), `projectJointSplit` and the disc
(`drawJointSplitFromCurve`) run unchanged there with the canvas transform mapping the result back, and the
cone bodies cut the node out by mapping the polygon, `subtractDisc`, and mapping back (`cutDisc`). The map is
affine, so hulls, crossings and arcs carry over exactly. A far node that is squashed contributes its ellipse
rim points (`rimPoints`) to the body's hull. On the joint disc, where both hulls end on the joint body's own
surface, the color is split by the ring's plane (side holding A's far center = A's color), which is what
`tools/jointRef.mjs` assumes at ties. Cost: about 3 ms per squashed joint per frame against 0.25 ms for
the closed form (the exact ring points dominate: ruled-normals-only Newton with interpolated generatrix
normals, then an exact polish); sphere joints are unaffected.
Known limitation: the joint disc is drawn over the cone bodies as one flat piece. For spheres a cone only
comes in front of the node's disc when its arm points at the camera, but a thin flat joint node (squash
about 0.3 and tilted: `jointFlat` in `jointRef.mjs`) lets a hull bulge in front of the node's rim, and a
sliver of the disc's color (about 10 x 70 px, 0.2% of the samples in the worst of 6 angles) is painted
where that cone should be. The demo's squash values (0.7, 1.5) are checked by `jointRef.mjs`'s `demoV`.
**Split cones with squashed nodes** (`splitRing.js`; used when the shared node, the far node or any host node is squashed,
else the closed forms below, bit-identical). Three cases, one definition of the ring. The ring is where the cone's
cross-section by a *slicing plane* last meets the host; the planes are `{ (p - c_shared) . w = const }`, `w = Q_shared^-1 d`
(d the unit axis, scaled so that the constant is the axial distance where the plane crosses the axis): planes
perpendicular to the axis once the shared body is a sphere. For a round shared node w = d, the old definition.
- **uniform shapes** (`findUniformSplitRing`): the shared node, the far node and every host node have the same squash and
  axis (radii may differ): S_i = r_i T for one linear map T, so under T^-1 it is the sphere problem, solved by the closed
  forms (`sphereSplitRing`) and mapped back: the generatrices are T of the sphere cone's (analytic, no Newton) and
  the ring constant is s' / |T^-1 d|. This is what a mesh squashing alike (a bounce) costs per recompute. Joints can't use
  it: their flat bodies come from each node's own perspective Jacobian, so same-shape nodes are not exact affine copies
  there (they keep the general ring);
- **general numeric** (`findGeneralSplitRing`): the cone is the `hullCone.js` hull of the two bodies and the host the convex
  hull of its bodies (`hostHull.js`, what the sphere code's host sdf amounts to for convex meshes). Along each generatrix
  pN + t (pF - pN) the host distance is convex in t and <= 0 at t = 0, so it leaves the host at one t (Newton from t = 1,
  slope = best normal . direction); its plane constant is ell(pN) + t (ell(pF) - ell(pN)) and the ring is at the largest over
  the generatrices (refined in azimuth for a grazing contact, kept where every generatrix crosses). With round nodes it
  reproduces the sphere closed form to rounding (`tools/splitCheck.mjs`);
- the result is cached and camera-independent; it carries `general = { cone, tStar }`.
On screen (`splitScreenPoints`, `shapes.js`) each generatrix end is mapped by its own node's linear map (`projectNode`'s
`axes` and `scale`: center + scale (d . right, -d . up), plain camera axes for spheres), and a ring point interpolates the two
at `tStar`, so the ring and the tangent curve lie on the drawn ellipses. The host-colored part (`drawSplitSharedGeneral`)
is the hull of the ring and tangent polygons and the arc of the shared node's rim ellipse on the shared side (the
shared body's support >= the far body's along the rim point's world normal `cx right - cy up`, the sphere test
`n . axis <= sinT` in general form; its ends by bisection); the far part (`drawSplitFarGeneral`) the hull of the ring and
the far rim ellipse, with a chord instead of the cap at a joint. Both are `hullOutline`s (exact arcs). A split cone ending
at a squashed joint aligns its ring to the flat capsule of the two ellipses (`alignToFlatEllipses`, from `ellipseCapsule`).
The cone debug overlay skips squashed splits. The host is treated as convex. The demo's pyramid, its apex and the orange
end are squashed.

**Exact outlines** (`hullOutline`, `traceOutline` / `fillOutline`). The split cone parts of round nodes are hulls of
ellipses and an arc, no sampled points: the projected ring and tangent circle are exact ellipses (`projectedCircleEllipse`:
the perspective image of a circle is a conic, fitted through five exact projections), the shared rim is the arc where
`n . axis = R cos(theta + delta) <= sinT`. The hull's support is the largest of the shapes' supports, so the boundary follows
one shape between the normal angles where two supports are equal (edge normals of the point hull, tangents from a point to
an ellipse, common tangents of two ellipses, the ends of an arc's range: all closed form) and is drawn as corners and
`ctx.ellipse` arcs. The quartic for two ellipses' common tangents is ill-conditioned for some pairs (two far-apart, nearly
parallel ellipses lost all their roots at orbit angles 5.59-5.60: the cone's capsule degenerated to one ellipse and the
yellow cone vanished), so `ellipseTangentAngles` checks its roots against a 96-angle sign scan and falls back to the
bisected scan when it finds fewer crossings. Where a polygon is needed (the joint bodies feed the polygon booleans) the rim points are
chord-tolerance driven (`ellipsePolygon`, 2.5 x `CURVE_TOL_PX`) instead of a fixed 64 / 128.

**Frame pipeline (`render`):** project nodes → ownership map (node → meshes) →
joint rings → one primitive per node pair (plus one per joint) → sort
back to front → draw. Consecutive traced primitives of one mesh are batched.

**Layering (depth strata, `slabsOf` / `drawPrimitives` in `render.js`).** One sort key per piece cannot order
pieces that are nearer at one end and farther at the other (or that overlap cyclically), so pieces are cut
at fixed global depth strata (`DEPTH_BIN` = 16 world units). A piece with a depth ramp (`makeSlice`: the screen
axis between its two end nodes and their depths; plain pairs, joint bodies, split cone far parts) gets one
slab per stratum it spans; slabs are drawn farthest stratum first and, inside a stratum, by the piece's own
key (`depth`), so every rule that works on piece keys (the layered split cone keys, `orderJointBodies`, the
joint disc after its bodies) still holds inside a stratum. Pieces without a ramp (joint discs, the split
node's shared part) sit in the stratum of `binDepth`. A piece is drawn whole, exactly as an uncut piece
(batched, no clip, no seam), when its slabs can be put together: only pieces whose screen box (`boxOf`)
overlaps it and that have another color are in the way, so the rest between its slabs don't count. Otherwise
a run of its slabs is drawn through a clip strip along its slice axis (its outline recorded once and
replayed), widened by `SEAM_PX` toward each neighboring slab that is drawn LATER so the earlier one reaches
under the later one (rule 1; strip edges are straight, so rule 4 holds). Strata decide between SEPARATE meshes only.
Meshes that share a node (the cones of a joint, a split cone and its host; `buildClusters`, `prim.cluster`)
keep the normal piece-key logic between each other: for two pieces of one cluster whose screen boxes overlap,
the piece with the larger key draws first, whatever strata their slabs are in (`orderByCluster`: Kahn's
algorithm on those constraints plus "slabs of one piece in strata order", taking the earliest entry of the
strata order each time, so an entry that must wait is moved later). That keeps front body after back body, a
joint disc after its bodies, and a split cone over its host when it faces the camera / under it when it faces
away; without it, strata interleaved a cone with its host (green strips clipped over the yellow cone, a
smoothly moving straight edge, at 2.47; the cone popping over/under the host between 0.76 and 1.25). The cut is
by depth along the piece's axis only: the fill triangle of a 3+ node mesh follows the capsule's ramp
(approximate).

**Border strokes** (`strokes` in `config.js`, the Strokes button; `drawPrimitives`, `paintRecorded`, `strokeUnder`). Where a
mesh is drawn over ANOTHER mesh of the same color, its edge gets a black stroke of `strokes.px` canvas pixels (constant on
screen: the line width is divided by `pxPerUnit`). Only colors worn by 2+ meshes take this path (`strokeColorsOf`); everything
else is drawn exactly as before. Each fill of such a mesh (a batch flush, a clipped slab run, a joint disc / body, a split cone
part) is recorded first (`record`), then replayed; before each fill its outline (a `Path2D`, transforms baked in) is stroked on an
offscreen canvas at 2x the width, masked to the other same-colored meshes' fills painted so far (`painted`, so never over the
background) minus the mesh's own earlier fills (never along its own piece seams), composited on the main canvas, and only then
the fill covers the stroke's inner half, so the stroke sits above the lower mesh and below the top one (the visible part is the
outer `px`, with no on-top patch, rule 1). Fill ownership: `prim.meshId`, or `prim.owners` in fill order (joint disc: dominant
then crescent mesh, so a joint of same-colored meshes gets its ring stroked; split cone host part: the host). Every `draw` /
`tracePath` takes the context as an argument so it can be recorded. Limits: "on top" is draw order, so a third-color piece drawn
between the two meshes inside the lower one's area can get a stroke painted over it; the lower mesh's mask is its fills' coverage,
not its visible pixels. Demo: the basic scene's pink arch is recolored to orange to show it.
**Skewed halves.** The same stroke separates the two halves of one skewed mesh, always (no fold test: the stroke lengthens and
shortens with the real overlap instead of switching on). Each half is its own ink owner (`"id.0"` / `"id.1"`, `meshOf`) and its
own fill, so the one-sample overlap strip around the apex doubles the AA edge there. That strip is not a border: both halves'
strokes have the body of the samples apex-1 .. apex+1 (plus the stroke's width) cut out (`strokeCut`, `destination-out`), so a
real fold crossing the apex shows no stroke inside that strip. Which half is on top is the draw order (mean sample depth).

**Light engine** (`light.js`, `shading.js`; `light` / `lighting` in `config.js`; the Light button). One directional world light
(`light.dir`, parallel rays, fixed in the world) and, for now, two tones: Lit (the mesh color) and Twilight (`toneColor` mixes toward
black; Unlit, Shade and Shining are defined in `toneMix` for the local "harsh" lights and shadows to come). A surface is Lit when its
normal faces the light (n . L >= 0): one half of every sphere or cone is lit, the other is not. Everything is computed in a per-frame
orthographic flat solid (screen x, y (y down), z = -depth * `camera.zoom` toward the viewer, each node a sphere of its projected radius),
so terminators meet the drawn silhouettes. A piece has `prim.shade()` -> *elements*; it is filled in Twilight (`baseColor`) and, after
each recorded fill (`paintRecorded`), the lit parts of its elements are painted over it clipped to the fill (`shading.paint`):
- `sphere`: the lit cap, bounded by the great circle n . l = 0 (it projects to an ellipse through the node's center, `capRegion`) and
  the rim arc; a sphere shows only its *exposure* (normals with n . d <= sinT toward each partner, the cones' tangent circles), so the
  spheres and cone strips of a hull tile its visible surface and a far node behind a near one paints nothing;
- `cone`: the lit generatrices (n . l >= 0, each a straight line, exact intervals of angles, `intersectArcs`) among the visible ones
 . The cone and the sphere it meets are separate shapes that end on the
  same circle; the antialiased edges of both leave a thin line of the base tone, so a *seam line* along the end circles
  (`SEAM_LINE_PX`, in the lit tone) closes it. Nothing is extended past its edge;
- `face` (3+ node meshes): a visible plane tangent to three spheres with the others below it, a flat triangle through the tangent points,
  wholly Lit or Twilight, painted over the others and stroked `FACE_STROKE_PX` wide (a single layer shows the base tone at its edge).
`pair(pa, pb)` (2-node meshes, split cones) lights the two nodes and the cone as a *tube*: l is the light's component perpendicular to
the axis, so a generatrix has one tone along its whole length and a node's border (the great circle n . l = 0, a plane parallel to the
axis) continues the cone's straight border across the seam without a corner. The cost is that the axial part of the light is dropped
(light along the axis gives nothing lit, and the lit side flips as the axis passes through the light's direction). `hull(meshId, nodes)` (3+ node meshes) lights the hull of the spheres by the light itself (n . L >= 0): each node's lit cap (exposure = the cones' tangent circles of the hull's edges), each edge's cone (lit generatrices, minus those under a face) and the visible faces, so the pieces agree on the normal wherever they meet; EVERY piece of the mesh paints all of its elements (spheres, cones, faces) over its own fill: pieces drawn separately (depth strata) overlap, and a later piece's Twilight base would cover an earlier piece's lit cone where it overlaps (a dark notch at the node, seen at 1.904). The borders do NOT line up smoothly: the cone's border is a straight generatrix, the node's a great circle, and the hull's curvature jumps at each tangent circle, so there is a corner at each seam (a smoothed single-curve version, blending the nodes' support points, was tried and dropped: its borders moved around). The Debug view draws, per cone, in its own color, the generatrices where its lit part starts and ends with a dot at both tangent circles, each node's cap border dashed black, and the border between each cone and its nodes (the visible tangent circles) dotted white (`drawDebug`), to see which shapes compete. A split cone's host mesh as the convex hull of its node bodies (hosts with squashed nodes): exact signed distance (`hostProbe`): a table of 4096 normals only says which bodies are in play, then the candidates (each body's nearest-point normal, each pair's ruled curve, each triple's face normal) are evaluated with the true support |
| `shapeDebug.js` | Debug button's overlay: dotted screen outline of every node (+ cut and axes of squashed ones); a skew node shows instead the body's cross-section at that point of the arch (`sectionAt`, `skew.js`) |
| `main.js` | Canvas setup, Pause / Dark mode / Debug buttons, animation loop |
| `tools/` | Headless Node checks (copy the modules first, they need `"type":"module"`): `trace.mjs` records the canvas calls over the orbit to diff two copies (`SPHERES=1` makes every node round), `shapeCheck.mjs` spheroid math, `hullCheck.mjs` ellipse capsule vs brute-force hull, `orientCheck`/`perspectiveCheck`/`silhouetteCheck` node ellipses vs the 3D body, `coneCheck.mjs` / `ellipsoidCheck.mjs` `hullCone.js` vs the sphere cone and a brute-force hull, `jointParity.mjs` the general joint ring with spheres vs the closed form, `jointCheck.mjs` its invariants and timing on squashed bodies, `jointSweep.mjs` frame-to-frame continuity of the demo's joint over the orbit, `jointRef.mjs` painted colors of a squashed V vs an exact ray cast of its flat solid (`STEP=4 node tools/jointRef.mjs <dir> all 6 <png-prefix>` writes drawn | reference | mismatch images), `meshCheck.mjs` rasterizes the squashed meshes' fills in real frames and compares them with the hull of their node ellipses, `outlineCheck.mjs` the exact ellipse / outline / conic math against brute force, `hostCheck.mjs` `hostProbe` against a brute-force hill climb, `splitCheck.mjs` the uniform closed form and the numeric split ring against each other and the sphere closed form, `frameTime.mjs` ms per `render()` of the demo (`SPHERES=1`: all round) |

## Skewed meshes
`createMesh([a, b], color, { skew: nodeId })` bends a 2-node mesh through a third node (`skew.js`, `buildSkewPrimitives` in
`render.js`). The skew node is only a point: its radius and shape are ignored. The path is the ellipse with conjugate
semi-diameters `(B - A) / 2` and `S - M`, so S is the apex even when off-center. The cross-section comes from the two end nodes
only: each end's `shape.Q` is written in the arch's moving frame (tangent, in-plane normal, plane normal), the two forms are
mixed with a smoothstep and turned back (`shapeAt`); the whole ellipsoid is swept, so a flat end's extent along the arch makes the band bulge where the arch bends. That is intended: sweeping only the cross-section (tried) leaves the ribbon drifting off the flat end discs, so the arch must start and end on the nodes' own shapes. The Debug view's section (`sectionAt`) is the true cut perpendicular to the arch, so it differs from the drawn bulge. So thickness and width are kept along the arch (no swelling from mixing
differently oriented shapes in world coordinates). All-round ends use the circle path with a smoothstep radius. On screen the body
is the union of capsules between consecutive projected circles / ellipses (`archSamples`, refined until in-between ones lie inside
their neighbors' capsule; `traceEllipseCapsule` for squashed ends), traced into one nonzero path. v1 limits: plain meshes only
(skewed meshes are left out of `buildOwnership`, so no joints or split cones), two primitives split at the skew node
(`buildSkewPrimitives`, overlapping by one sample past the apex on each side so a ribbon's two halves have no seam, `slice: null`, key = the mean sample depth of each half), box-only overlap tests.
Scenes: `?scene=basic` (default, `buildBasicScene`) and `?scene=full` (`buildFullScene`, the squashed demo).

## Squashed nodes
A node is a spheroid: `createNode(center, radius, { squash, axis })`; `node.shape` (`makeShape`,
`geometry.js`) has semi-axis `radius * squash` along `axis` and `radius / sqrt(squash)` across (same volume).
`projectNode` gives its screen shadow `ellipse` `{a, b, angle}` (closed form, `shadowEllipse`) and `round`
(true for squash === 1, which keeps every circle code path bit-identical). Supported so far: **plain
pieces only** (`buildPairPrimitive`'s `tracePath`): the capsule is the hull of the two ellipses
(`ellipseHullArcs` finds where the support functions cross; `traceEllipseCapsule` draws the arcs and
common tangents). The Debug overlay (`shapeDebug.js`) also draws the shape's **cut**: the fixed 3D
meridian ellipse through both poles (semi-axes `ra` along `axis`, `rp` along `shape.cutDir`, a direction
across the axis, default world +x; `createNode`'s `cut` option picks another). `projectNode` returns it as
`cut`; unlike the rendered silhouette it collapses to a line when its plane is edge-on (orange; the
silhouette is dashed purple). Both are projected with the projection's Jacobian at the node (`projectNode`),
a linear map: a node off the view axis shows its top or underside, and the shapes stay exact ellipses with
no lens distortion (the cut always lies inside the silhouette). Spheres keep the plain camera basis, so
they stay circles.

**Joints with squashed nodes** (`computeJoints`, `render.js`). If any of a joint's three nodes is
squashed, its ring is the general one (`jointCurveGeneral.js`); all-round joints keep the closed form
(bit-identical output). The flat solid gives each node an ellipsoid (`ellipsoidShape`, `flatBody`): its
projected ellipse as the shadow along z (so the orthographic silhouette is exactly what is drawn) and the
body's own half-extent along the view (`zRadius`) as the third axis. Cones are `hullCone.js` hulls of the
joint body and each far body. The ring is not planar any more:
- touch points: the normals where both cones touch the joint body (hN = hFA = hFB), found on A's contact curve
  (azimuth psi) where hFB - hN changes sign; the front arc of psi is the one with hFB > hN (A's generatrix
  starts inside hull B there);
- front: per psi, the point where A's generatrix leaves hull B. `hullSigned` is convex along a line, so Newton
  from the far end converges monotonically (slope = probe normal . direction). 31 exact points
  (cosine-spaced, warm-started), a cubic Hermite spline through them, and an exact point added wherever the
  spline's midpoint is off by more than half the chord tolerance, then chords within `tol`;
- back: the plane through both touch points and the centroid of the exact front points cuts the joint
  ellipsoid in an ellipse (computed on the unit sphere `Sinv (x - c)`); the stretch through the back is the
  back arc. `curve.plane` is that plane (used for `frontIsA`);
- edge stops: the silhouette generatrices (n.z = 0) cross the other hull at the contact when their azimuth is in
  the ring's arc.
The 2D side of a squashed joint node works in a *unit-circle space* (`ellipseUnitMap`): the screen ellipse is
mapped by a linear map to a circle of radius b (the long axis shrunk), `projectJointSplit` and the disc
(`drawJointSplitFromCurve`) run unchanged there with the canvas transform mapping the result back, and the
cone bodies cut the node out by mapping the polygon, `subtractDisc`, and mapping back (`cutDisc`). The map is
affine, so hulls, crossings and arcs carry over exactly. A far node that is squashed contributes its ellipse
rim points (`rimPoints`) to the body's hull. On the joint disc, where both hulls end on the joint body's own
surface, the color is split by the ring's plane (side holding A's far center = A's color), which is what
`tools/jointRef.mjs` assumes at ties. Cost: about 3 ms per squashed joint per frame against 0.25 ms for
the closed form (the exact ring points dominate: ruled-normals-only Newton with interpolated generatrix
normals, then an exact polish); sphere joints are unaffected.
Known limitation: the joint disc is drawn over the cone bodies as one flat piece. For spheres a cone only
comes in front of the node's disc when its arm points at the camera, but a thin flat joint node (squash
about 0.3 and tilted: `jointFlat` in `jointRef.mjs`) lets a hull bulge in front of the node's rim, and a
sliver of the disc's color (about 10 x 70 px, 0.2% of the samples in the worst of 6 angles) is painted
where that cone should be. The demo's squash values (0.7, 1.5) are checked by `jointRef.mjs`'s `demoV`.
**Split cones with squashed nodes** (`splitRing.js`; used when the shared node, the far node or any host node is squashed,
else the closed forms below, bit-identical). Three cases, one definition of the ring. The ring is where the cone's
cross-section by a *slicing plane* last meets the host; the planes are `{ (p - c_shared) . w = const }`, `w = Q_shared^-1 d`
(d the unit axis, scaled so that the constant is the axial distance where the plane crosses the axis): planes
perpendicular to the axis once the shared body is a sphere. For a round shared node w = d, the old definition.
- **uniform shapes** (`findUniformSplitRing`): the shared node, the far node and every host node have the same squash and
  axis (radii may differ): S_i = r_i T for one linear map T, so under T^-1 it is the sphere problem, solved by the closed
  forms (`sphereSplitRing`) and mapped back: the generatrices are T of the sphere cone's (analytic, no Newton) and
  the ring constant is s' / |T^-1 d|. This is what a mesh squashing alike (a bounce) costs per recompute. Joints can't use
  it: their flat bodies come from each node's own perspective Jacobian, so same-shape nodes are not exact affine copies
  there (they keep the general ring);
- **general numeric** (`findGeneralSplitRing`): the cone is the `hullCone.js` hull of the two bodies and the host the convex
  hull of its bodies (`hostHull.js`, what the sphere code's host sdf amounts to for convex meshes). Along each generatrix
  pN + t (pF - pN) the host distance is convex in t and <= 0 at t = 0, so it leaves the host at one t (Newton from t = 1,
  slope = best normal . direction); its plane constant is ell(pN) + t (ell(pF) - ell(pN)) and the ring is at the largest over
  the generatrices (refined in azimuth for a grazing contact, kept where every generatrix crosses). With round nodes it
  reproduces the sphere closed form to rounding (`tools/splitCheck.mjs`);
- the result is cached and camera-independent; it carries `general = { cone, tStar }`.
On screen (`splitScreenPoints`, `shapes.js`) each generatrix end is mapped by its own node's linear map (`projectNode`'s
`axes` and `scale`: center + scale (d . right, -d . up), plain camera axes for spheres), and a ring point interpolates the two
at `tStar`, so the ring and the tangent curve lie on the drawn ellipses. The host-colored part (`drawSplitSharedGeneral`)
is the hull of the ring and tangent polygons and the arc of the shared node's rim ellipse on the shared side (the
shared body's support >= the far body's along the rim point's world normal `cx right - cy up`, the sphere test
`n . axis <= sinT` in general form; its ends by bisection); the far part (`drawSplitFarGeneral`) the hull of the ring and
the far rim ellipse, with a chord instead of the cap at a joint. Both are `hullOutline`s (exact arcs). A split cone ending
at a squashed joint aligns its ring to the flat capsule of the two ellipses (`alignToFlatEllipses`, from `ellipseCapsule`).
The cone debug overlay skips squashed splits. The host is treated as convex. The demo's pyramid, its apex and the orange
end are squashed.

**Exact outlines** (`hullOutline`, `traceOutline` / `fillOutline`). The split cone parts of round nodes are hulls of
ellipses and an arc, no sampled points: the projected ring and tangent circle are exact ellipses (`projectedCircleEllipse`:
the perspective image of a circle is a conic, fitted through five exact projections), the shared rim is the arc where
`n . axis = R cos(theta + delta) <= sinT`. The hull's support is the largest of the shapes' supports, so the boundary follows
one shape between the normal angles where two supports are equal (edge normals of the point hull, tangents from a point to
an ellipse, common tangents of two ellipses, the ends of an arc's range: all closed form) and is drawn as corners and
`ctx.ellipse` arcs. The quartic for two ellipses' common tangents is ill-conditioned for some pairs (two far-apart, nearly
parallel ellipses lost all their roots at orbit angles 5.59-5.60: the cone's capsule degenerated to one ellipse and the
yellow cone vanished), so `ellipseTangentAngles` checks its roots against a 96-angle sign scan and falls back to the
bisected scan when it finds fewer crossings. Where a polygon is needed (the joint bodies feed the polygon booleans) the rim points are
chord-tolerance driven (`ellipsePolygon`, 2.5 x `CURVE_TOL_PX`) instead of a fixed 64 / 128.

**Frame pipeline (`render`):** project nodes → ownership map (node → meshes) →
joint rings → one primitive per node pair (plus one per joint) → sort
back to front → draw. Consecutive traced primitives of one mesh are batched.

**Layering (depth strata, `slabsOf` / `drawPrimitives` in `render.js`).** One sort key per piece cannot order
pieces that are nearer at one end and farther at the other (or that overlap cyclically), so pieces are cut
at fixed global depth strata (`DEPTH_BIN` = 16 world units). A piece with a depth ramp (`makeSlice`: the screen
axis between its two end nodes and their depths; plain pairs, joint bodies, split cone far parts) gets one
slab per stratum it spans; slabs are drawn farthest stratum first and, inside a stratum, by the piece's own
key (`depth`), so every rule that works on piece keys (the layered split cone keys, `orderJointBodies`, the
joint disc after its bodies) still holds inside a stratum. Pieces without a ramp (joint discs, the split
node's shared part) sit in the stratum of `binDepth`. A piece is drawn whole, exactly as an uncut piece
(batched, no clip, no seam), when its slabs can be put together: only pieces whose screen box (`boxOf`)
overlaps it and that have another color are in the way, so the rest between its slabs don't count. Otherwise
a run of its slabs is drawn through a clip strip along its slice axis (its outline recorded once and
replayed), widened by `SEAM_PX` toward each neighboring slab that is drawn LATER so the earlier one reaches
under the later one (rule 1; strip edges are straight, so rule 4 holds). Strata decide between SEPARATE meshes only.
Meshes that share a node (the cones of a joint, a split cone and its host; `buildClusters`, `prim.cluster`)
keep the normal piece-key logic between each other: for two pieces of one cluster whose screen boxes overlap,
the piece with the larger key draws first, whatever strata their slabs are in (`orderByCluster`: Kahn's
algorithm on those constraints plus "slabs of one piece in strata order", taking the earliest entry of the
strata order each time, so an entry that must wait is moved later). That keeps front body after back body, a
joint disc after its bodies, and a split cone over its host when it faces the camera / under it when it faces
away; without it, strata interleaved a cone with its host (green strips clipped over the yellow cone, a
smoothly moving straight edge, at 2.47; the cone popping over/under the host between 0.76 and 1.25). The cut is
by depth along the piece's axis only: the fill triangle of a 3+ node mesh follows the capsule's ramp
(approximate).

**Border strokes** (`strokes` in `config.js`, the Strokes button; `drawPrimitives`, `paintRecorded`, `strokeUnder`). Where a
mesh is drawn over ANOTHER mesh of the same color, its edge gets a black stroke of `strokes.px` canvas pixels (constant on
screen: the line width is divided by `pxPerUnit`). Only colors worn by 2+ meshes take this path (`strokeColorsOf`); everything
else is drawn exactly as before. Each fill of such a mesh (a batch flush, a clipped slab run, a joint disc / body, a split cone
part) is recorded first (`record`), then replayed; before each fill its outline (a `Path2D`, transforms baked in) is stroked on an
offscreen canvas at 2x the width, masked to the other same-colored meshes' fills painted so far (`painted`, so never over the
background) minus the mesh's own earlier fills (never along its own piece seams), composited on the main canvas, and only then
the fill covers the stroke's inner half, so the stroke sits above the lower mesh and below the top one (the visible part is the
outer `px`, with no on-top patch, rule 1). Fill ownership: `prim.meshId`, or `prim.owners` in fill order (joint disc: dominant
then crescent mesh, so a joint of same-colored meshes gets its ring stroked; split cone host part: the host). Every `draw` /
`tracePath` takes the context as an argument so it can be recorded. Limits: "on top" is draw order, so a third-color piece drawn
between the two meshes inside the lower one's area can get a stroke painted over it; the lower mesh's mask is its fills' coverage,
not its visible pixels. Demo: the basic scene's pink arch is recolored to orange to show it.
**Skewed halves.** The same stroke separates the two halves of one skewed mesh, always (no fold test: the stroke lengthens and
shortens with the real overlap instead of switching on). Each half is its own ink owner (`"id.0"` / `"id.1"`, `meshOf`) and its
own fill, so the one-sample overlap strip around the apex doubles the AA edge there. That strip is not a border: both halves'
strokes have the body of the samples apex-1 .. apex+1 (plus the stroke's width) cut out (`strokeCut`, `destination-out`), so a
real fold crossing the apex shows no stroke inside that strip. Which half is on top is the draw order (mean sample depth).

**Light engine** (`light.js`, `shading.js`; `light` / `lighting` in `config.js`; the Light button). One directional world light
(`light.dir`, parallel rays, fixed in the world) and, for now, two tones: Lit (the mesh color) and Twilight (`toneColor` mixes toward
black; Unlit, Shade and Shining are defined in `toneMix` for the local "harsh" lights and shadows to come). A surface is Lit when its
normal faces the light (n . L >= 0): one half of every sphere or cone is lit, the other is not. Everything is computed in a per-frame
orthographic flat solid (screen x, y (y down), z = -depth * `camera.zoom` toward the viewer, each node a sphere of its projected radius),
so terminators meet the drawn silhouettes. A piece has `prim.shade()` -> *elements*; it is filled in Twilight (`baseColor`) and, after
each recorded fill (`paintRecorded`), the lit parts of its elements are painted over it clipped to the fill (`shading.paint`):
- `sphere`: the lit cap, bounded by the great circle n . l = 0 (it projects to an ellipse through the node's center, `capRegion`) and
  the rim arc; a sphere shows only its *exposure* (normals with n . d <= sinT toward each partner, the cones' tangent circles), so the
  spheres and cone strips of a hull tile its visible surface and a far node behind a near one paints nothing;
- `cone`: the lit generatrices (n . l >= 0, each a straight line, exact intervals of angles, `intersectArcs`) among the visible ones
 . The cone and the sphere it meets are separate shapes that end on the
  same circle; the antialiased edges of both leave a thin line of the base tone, so a *seam line* along the end circles
  (`SEAM_LINE_PX`, in the lit tone) closes it. Nothing is extended past its edge;
- `face` (3+ node meshes): a visible plane tangent to three spheres with the others below it, a flat triangle through the tangent points,
  wholly Lit or Twilight, painted over the others and stroked `FACE_STROKE_PX` wide (a single layer shows the base tone at its edge).
`pair(pa, pb)` (2-node meshes, split cones) lights the two nodes and the cone as a *tube*: l is the light's component perpendicular to
the axis, so a generatrix has one tone along its whole length and a node's border (the great circle n . l = 0, a plane parallel to the
axis) continues the cone's straight border across the seam without a corner. The cost is that the axial part of the light is dropped
(light along the axis gives nothing lit, and the lit side flips as the axis passes through the light's direction). `hull(meshId, nodes)`
(3+ node meshes) uses the light itself for spheres, cones and faces, so they agree wherever they meet (the normal is continuous); each
piece paints its own two spheres, its cone and the mesh's faces. Borders can kink at a node where several cones meet. A split cone's
host-colored part = all of the host's elements (it is painted over the host's own pieces, so its Twilight base would otherwise cover them) + the cone lit by L itself (`shading.cone`), so the light model only changes on the split ring, where the color does; every host piece's shared-node sphere gives way to the split cones there (`hull.elements(frame.splitFarsOf)`, not skipped: a host piece drawn after the host part would cover the cap with its base). A joint disc has per-fill elements (`{ fills: [...] }`, like `owners`): each region gets its own tube's joint sphere and cone (`pair`, cached by the unordered pair), so each cone's straight border runs on across the disc and the tube changes only on the ring. The arch's shading (`arch(key, samples, cutAt)`) is always cut into sheets at the apex (a soft cut: no cover on the strips beside it) besides its folds (below), each sheet tagged with its `half`. The half drawn LATER (smaller key) paints every sheet: its round end disc reaches well past the apex, and painting only its own part left that disc in the base tone (a moon-phase look at the skew node, which itself is never drawn). The half drawn first paints only its own sheets (a sheet's `half` is read from the far row of its first strip: the strip across the apex cut starts on the sample before it): the other half's sheets are the 3D surface, not that half's drawn outline (a chain of flat circles), and where they reached past it they stayed on the earlier half (the front half's shading past its edge and border stroke, a base-tone band along the apex; top orange arch at 2.02). Its own disc past the apex is the later half's circle at that sample, so it is covered. Each end cap closes with a ring at its pole. A shaded
piece drawn through a depth-strata strip (`partial`) is built on a transparent group layer (`scratchLayers(ctx)[2]`) and composited once
through the strip's clip: painted directly, its base tone and lit part would each blend over what the neighboring strip painted through
the antialiased clip edge and leave a trace of the lower layer. **Skewed arches** (`buildArch`, `shading.arch`, in WORLD space; 65 uniform samples of the arch, independent of the drawn chain): each sample has its body's form K (x^T K x = 1: `inverse(shapeAt(...)(t))`, since `shape.Q` is S^2, or I/r^2 for round ends). The swept body's surface is the envelope of its ellipsoids: its point with unit normal n (n perpendicular to the arch's tangent) is c + S n / sqrt(n^T S n), S = K^-1. Per sample the normals are a circle n(phi) in the plane perpendicular to the tangent, so n . L >= 0 is exactly one arc of phi and n . v >= 0 (facing the viewer) another; the lit visible surface is their intersection (`meet`), whose ends are the terminator (independent of the camera) or the silhouette. Consecutive samples' arcs, cut into 5 steps, make quads in ONE path (no seam); the ends are capped with 10 rings n = cos(a) n(phi) + sin(a) out, with arcs cos(phi - phiL) >= -tan(a) (out . L) / |L_e|. Where one ring has lit arcs and the next has none (a lit patch starting between them, mostly on the caps), each arc tapers to a point halfway to the other ring; with 1 vs 2 arcs the strip is skipped. Where the two arcs are on different sides of the body (centers more than 1 rad apart: light from nearly behind, a rim sliver that shrinks to nothing where the light lines up with the view and comes back on the other silhouette), joining them crossed the whole arch as a thin lit wedge (2.465), and skipping the strip made each sliver end square (a break at 2.02); each sliver now tapers to a point on its silhouette, at the fraction of the step where the widths reach zero. Arc ends on the silhouette are pushed out 1.5 px (`ARCH_SEAM_PX`) so the lit part reaches the drawn outline. Folds: the arch is not convex, and a wide band turning past edge-on at a bend lies over itself on screen (the green ribbon at 4.04: t < 0.33 over t 0.33-0.5 in one half), so one lit path showed the hidden layer's light through the front one. The visible surface is front-facing everywhere, so a fold is not an orientation flip but a contour across the band: a silhouette point (an end of a row's visible arc) jumps across the band between two samples (`crosses`, never inside an end cap). The strips are cut into sheets there, and also where a strip overlaps on screen a non-neighbor (3+ strips back) of its sheet: a tube bending toward the camera hides its own earlier strips behind later ones with no contour across it (a lit rim crescent showed through at the apex of the threaded orange arch at 2.02); painted back to front (ordered by their depths at probe points where they overlap); a sheet that overlaps one painted before it first fills its visible quads in the base tone (`cover`), then its lit quads. The Debug view draws the terminator (the visible ends of the lit arcs) in magenta. Not shaded yet: squashed nodes of plain meshes, and the tone-aware border stroke color (still black).

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
    the flat solid below, recomputed each frame. With the plane fixed, the point on
    generatrix th is at t = -(al0 + radA w) / (nd + slope w), w = nu cos th + nv sin th,
    so every change between on-the-ring and off it (t = 0: the touch points; t at the
    cone's end; the pole of t; the two ends of cone B's frustum, which is linear in
    cos/sin once multiplied by the denominator) is at an angle given by
    a + b cos th + c sin th = 0. The ring is the run of arcs between those angles that
    ends at touch points on both sides (else the longest), cut into chords within
    `CURVE_TOL_PX` of the curve (`render.js`), not sampled at fixed angles. Marching A's generatrices out of
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
  layered key, so the other body moves to the right side of it). All joints are
  settled together, not one at a time: a cone between two joints is one
  primitive, and settling the joints one by one let the second undo the first
  (orange drawn over blue at the blue/orange joint, 1.75-1.84 and 4.53-4.72,
  because the orange/yellow joint had put orange right after the yellow split
  cone). A back body that is itself the front at another joint stays put and
  the front body moves instead; each disc is kept after its (moved) bodies. Without that the
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
  color changes at a *split ring*: the circle perpendicular to the axis at the
  host's *first contact* (`findSplitRing`, `splitRing.js`): the largest axial
  distance at which the cone's circle still meets the host. The host is its
  spheres, the true tangent cones between each pair (its capsules) and its faces
  (planes tangent to three spheres); `firstContact` takes each element's last
  contact and the largest wins:
  - sphere: the circle point nearest its center is in the center's radial
    direction, so contact is a quadratic in s;
  - capsule from the shared node: it and the split cone are both tangent to the
    shared sphere, so they meet in a plane (as at a joint); along each generatrix
    the plane's distance is a Mobius function of one scalar w = n.r(a), so its
    largest valid value is at w = +-W or a pole: closed form;
  - face: the circle's deepest point toward the plane is linear in s; kept if
    it lands on the face's triangle;
  - capsule between two other spheres: each generatrix's exit is a quadratic
    root, maximized over the generatrices numerically (rare: the cone must run
    along the host).
  Camera-independent and cached. It replaced sliding a 128-point circle out in
  64 steps against an approximate host sdf (ring within ~0.03 units of the old
  one; the old one also missed cones pointing into the host).
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
    ("facing" = camera on the far side of the ring plane, and the far node nearer than every host node: with the far node still behind the host's nearest node, the host's own pieces are in front of the cone, and drawing the far part over them cut the cone into the host at 3.406). A cone drawn as one
    unit let one cone's green half-disc land on another cone's far part when
    two cones share a host node. Cones facing alike are ordered by how much
    each points at the camera;
  - if the far node is a joint, the far part has no cap there (chord instead)
    and the joint disc is drawn after it;
  - no edge-on strip: a band of the far color laid over the host past the ring
    (when the far part is drawn first and the ring nearly edge-on) used to paint
    over the host's bulge beside the touch point. It was a fixed-width guess that
    popped on and off at its cutoff, and was dropped; near edge-on the host may
    show a small bite past the ring.
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
- Batch joint capsules and the split cone into unions too (rule 3).
- The joint bodies' polygons (ring loops of ~150 points, the polygon booleans) are the largest remaining source of
  path operations; an outline with arc edges through `subtractDisc` / `subtractPolygon` would remove it.
- `firstContact`'s capsule between two non-shared host spheres scans 72 angles as seeds and refines the two best peaks
  by a golden section (cached, so it only runs when a node moves); a closed form is a high-degree polynomial.

## Performance notes
Per frame, normal view, about half the time of the previous version (profile with a
Node harness, see Debugging). What is closed form or cached now:
- `findSplitRing` / `findLastContact` are cached per cone against a snapshot of the
  numbers of the nodes they use (one entry per cone, so no growth when nodes move).
- Joint cone edges (`edgeContacts`) come from `a = psi +- acos(-axis.z tanT / Wz)`, not
  a 720-angle scan; the ring's range and its chords are described under "Joint ring".
  The second cone's normal along the ring is its generatrix normal, not a
  finite difference of the frustum sdf.
- `subtractDisc` / `subtractPolygon` walk the polygon's vertices plus its exact
  crossings with the cut (no resampling), with bounding-box rejection against the cut.
- `alignToFlatCone` uses the capsule's closed form (two tangent segments, two arcs)
  instead of hulls of 180-point rims. The crescent's area is exact (polygon + circular segment).
- cos/sin tables for the 128-point circles; `seamUnderlap` is read from the
  transform once per frame (`frame.pxPerUnit`); `findSplit` once per mesh per frame.
- A 2-node mesh's fill triangle is flat (centroid on the line between its centers) and
  is not traced. `drawTriangle` / `drawPairCapsule` were unreachable and are gone.
- Squashed joints (demo: 5 of them; 39 ms -> 7 ms per frame): hull cones and probes work on scalars (`shape.Q`, no
  {x, y, z} objects in the inner loops) and every normal is exact (Newton on g from an interpolated phi, no
  interpolation used as the answer); the ring is a few exact solves (about 28, was 195) plus a Hermite spline whose tangents
  are the exact `nA x nB` with lengths `2 L / (1 + T . c)` (exact for a circle), checked by the distance from an exact point
  to the spline (not by comparing the spline at an equal parameter value, which measures the speed, not the shape); each
  solve starts from the last frame's `t` / azimuth (`MEMORY` in `jointCurveGeneral.js`, keyed by the joint node) and an
  unchanged joint returns the same curve and edge stops.
- Layering: pieces are tested for overlap by capsules along their axes (`piecesOverlap`), not boxes; a clipped pass fills a
  `Path2D` built once from the piece's recorded path (a plain-object recorder, no Proxy) instead of replaying hundreds of
  path calls per strip: canvas calls per frame 8.5k -> 2.3k in the demo.

## Debugging
- The **Debug** button turns all the debug views on and off together
  (`debug.on` in `config.js`, off at load; `debug.gap` / `cone` / `joint`
  choose which views it shows):
  - gap: paints the background magenta, which makes seam gaps show up;
  - cone (`coneDebug.js`): draws, on top of the frame, where each split cone's
    surface meets its host mesh in 3D (root-found along the cone's
    generatrices): amber = the split ring the split cone uses (dot = where it
    touches the host), pink = cone ∩ other host spheres (the curves on the
    capsules and faces aren't drawn). Dotted = buried in the host;
    otherwise solid = near side of the cone, dashed = far side. Lime dot = the
    cone's *last* contact (`findLastContact`): walking each generatrix from the
    far node inward, its entry is where it first goes into the host; the amber
    dot is the generatrix whose entry is farthest out, the lime one the
    generatrix whose entry is nearest the shared node. A hollow lime ring means
    that generatrix never enters the host and reaches the shared sphere at its
    tangent point. (Splitting the colors at a ring tilted through both dots was
    tried, with the ring rebuilt in the flat solid, a front-arc split and the
    host clipped at the ring, and dropped: in 3D the host covers parts of a
    tilted ring at some angles, so any 2D border there clips awkwardly.)
  - joint (`jointDebug.js`): each 2-to-2 joint's ring in the flat solid:
    magenta = touch points, cyan = the cones' intersection (front of the ring),
    green = the plane's circle across the sphere's back; solid where it faces
    the camera, dashed where it faces away. Each cone edge's stop
    (`joint.contacts`): black dot = where it touches the ring, hollow ring =
    where it ends on the node circle instead. The label gives the phase and the
    front mesh's color;
- The **Angle** slider at the bottom picks the camera's orbit angle (it pauses the
  orbit; while it runs the slider follows it). Use its value to report an angle.
- The **Focus** button (`focus` in `config.js`, off at load) centers the camera on the bounding sphere of the first mesh of 3+ nodes (`focus.meshId` picks another) and magnifies until all of it fits on screen at any orbit angle (`focus.fill` of the half-height); it draws only that mesh and the meshes sharing a node with it (`focus.meshIds`, set in `main.js` `focusFrame`). Everything is still computed with all the meshes.
- The **Dark mode** button swaps the background between white and black.
  Light gaps show on black, dark ones on white.
- The browser can't be seen from Claude Code. Geometry is verified with
  headless Node harnesses: the modules are bundled into one script, run in a
  `vm` with a stubbed canvas context, and sampled over the camera orbit. Use a
  point-sampled raster to diff against a reference copy, and a
  coverage-composited rasterizer for AA effects. A refactor should show
  0 differing samples; a change from sampling to closed form should differ only
  within a pixel or two of an edge (check there are no differences in flat areas).
