import type { Geometry, Polygon, Point, Ring, LocalFrame } from './types.js';
export class StudioError extends Error {
    constructor(public readonly code: string, message: string, public readonly status = 400) {
        super(message);
        this.name = 'StudioError';
    }
}
export const M_PER_FT = 0.3048;
export const M2_PER_SQFT = M_PER_FT ** 2;
export const GEOMETRY_EPSILON_M = 1e-6;
const CROSS_EPS = 1e-8;
const A = 6378137;
const E2 = 6.6943799901413165e-3;
const B = A * Math.sqrt(1 - E2);
const radians = (v: number): number => v * Math.PI / 180;
const degrees = (v: number): number => v * 180 / Math.PI;
export const components = (g: Geometry): Ring[][] => g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
export const points = (g: Geometry): Point[] => components(g).flat(2);
export function finite(v: unknown, label: string, min: number, max: number): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
        throw new StudioError('invalid_number', `${label} must be a finite number between ${min} and ${max}.`);
    }
    return v;
}
export function signedArea(ring: Ring): number {
    const first = ring[0];
    if (!first)
        return 0;
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        const p = ring[i]!, q = ring[i + 1]!;
        sum += (p[0] - first[0]) * (q[1] - first[1]) - (q[0] - first[0]) * (p[1] - first[1]);
    }
    return sum / 2;
}
export function area(g: Geometry): number {
    return components(g).reduce((sum, rings) => sum + rings.reduce((s, r, i) => s + (i === 0 ? 1 : -1) * Math.abs(signedArea(r)), 0), 0);
}
const cross = (a: Point, b: Point, p: Point): number => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
function onSegment(p: Point, a: Point, b: Point): boolean {
    return Math.abs(cross(a, b, p)) <= CROSS_EPS &&
        p[0] >= Math.min(a[0], b[0]) - GEOMETRY_EPSILON_M && p[0] <= Math.max(a[0], b[0]) + GEOMETRY_EPSILON_M &&
        p[1] >= Math.min(a[1], b[1]) - GEOMETRY_EPSILON_M && p[1] <= Math.max(a[1], b[1]) + GEOMETRY_EPSILON_M;
}
export function intersects(a: Point, b: Point, c: Point, d: Point, proper = false): boolean {
    const x1 = cross(a, b, c), x2 = cross(a, b, d), x3 = cross(c, d, a), x4 = cross(c, d, b);
    const different = (x: number, y: number): boolean => (x > CROSS_EPS && y < -CROSS_EPS) || (x < -CROSS_EPS && y > CROSS_EPS);
    if (different(x1, x2) && different(x3, x4))
        return true;
    return !proper && (onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b));
}
export function inRing(p: Point, ring: Ring, boundary = true): boolean {
    let inside = false;
    for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i]!, b = ring[i + 1]!;
        if (onSegment(p, a, b))
            return boundary;
        if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0])
            inside = !inside;
    }
    return inside;
}
export function inGeometry(p: Point, g: Geometry, boundary = true): boolean {
    return components(g).some(r => inRing(p, r[0]!, boundary) && !r.slice(1).some(h => inRing(p, h, !boundary)));
}
const ringCrosses = (a: Ring, b: Ring, proper = false): boolean => {
    for (let i = 0; i < a.length - 1; i++)
        for (let j = 0; j < b.length - 1; j++) {
            if (intersects(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!, proper))
                return true;
        }
    return false;
};
function validateTopology(g: Geometry): void {
    for (const rings of components(g)) {
        for (const ring of rings) {
            if (Math.abs(signedArea(ring)) < 1e-4)
                throw new StudioError('zero_area', 'A boundary ring has no usable area.');
            for (let i = 0; i < ring.length - 1; i++) {
                if (Math.hypot(ring[i]![0] - ring[i + 1]![0], ring[i]![1] - ring[i + 1]![1]) < GEOMETRY_EPSILON_M)
                    throw new StudioError('duplicate_vertex', 'Remove consecutive duplicate boundary vertices.');
                for (let j = i + 2; j < ring.length - 1; j++) {
                    if (i === 0 && j === ring.length - 2)
                        continue;
                    if (intersects(ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!))
                        throw new StudioError('self_intersection', 'The boundary crosses or touches itself. Repair it before importing.');
                }
            }
        }
        const outer = rings[0]!;
        for (let h = 1; h < rings.length; h++) {
            const hole = rings[h]!;
            if (!inRing(hole[0]!, outer, false) || ringCrosses(outer, hole))
                throw new StudioError('invalid_hole', 'A hole must lie strictly inside its outer boundary without touching it.');
            for (let k = 1; k < h; k++) {
                const other = rings[k]!;
                if (ringCrosses(hole, other) || inRing(hole[0]!, other) || inRing(other[0]!, hole))
                    throw new StudioError('overlapping_holes', 'Holes cannot overlap, touch, or contain each other.');
            }
        }
    }
    const parts = components(g);
    for (let i = 0; i < parts.length; i++)
        for (let j = i + 1; j < parts.length; j++) {
            const a = { type: 'Polygon', coordinates: parts[i]! } as const, b = { type: 'Polygon', coordinates: parts[j]! } as const;
            if (a.coordinates.some(r => b.coordinates.some(s => ringCrosses(r, s))) || inGeometry(a.coordinates[0]![0]!, b) || inGeometry(b.coordinates[0]![0]!, a)) {
                throw new StudioError('overlapping_parts', 'Multipart boundaries must be disjoint. Touching or overlapping components require professional geometry repair.');
            }
        }
    if (area(g) < 0.01)
        throw new StudioError('unusable_area', 'The site has less than 0.01 square metres of usable area.');
}
/** Bounded validation, not geometry repair. Never closes, trims, or drops rings. */
export function readGeometry(input: unknown, space: 'geographic' | 'local' = 'local'): Geometry {
    if (!input || typeof input !== 'object')
        throw new StudioError('invalid_geometry', 'Provide a GeoJSON Polygon or MultiPolygon.');
    const raw = input as Record<string, unknown>;
    if (raw.type !== 'Polygon' && raw.type !== 'MultiPolygon')
        throw new StudioError('unsupported_geometry', 'Only Polygon and MultiPolygon boundaries are supported; a building point is not a site boundary.');
    const parts: unknown = raw.type === 'Polygon' ? [raw.coordinates] : raw.coordinates;
    if (!Array.isArray(parts) || parts.length < 1 || parts.length > 16)
        throw new StudioError('geometry_budget', 'Use one to sixteen polygon components.');
    let total = 0;
    const clean = parts.map((p: unknown): Ring[] => {
        if (!Array.isArray(p) || !p.length || p.length > 32)
            throw new StudioError('geometry_budget', 'Use one outer ring and at most 31 holes per component.');
        return p.map((r: unknown): Ring => {
            if (!Array.isArray(r) || r.length < 4 || r.length > 512)
                throw new StudioError('geometry_budget', 'Each ring needs 4 to 512 vertices, including its closing vertex.');
            total += r.length;
            if (total > 2048)
                throw new StudioError('geometry_budget', 'The import exceeds the 2,048-vertex Studio budget. Simplify it in a GIS tool first.');
            const ring = r.map((v: unknown): Point => {
                if (!Array.isArray(v) || v.length !== 2)
                    throw new StudioError('invalid_coordinate', 'Coordinates must be numeric [x, y] pairs. Elevation coordinates need a separately reviewed import.');
                return [finite(v[0], 'X / longitude', space === 'geographic' ? -180 : -2000, space === 'geographic' ? 180 : 2000), finite(v[1], 'Y / latitude', space === 'geographic' ? -75 : -2000, space === 'geographic' ? 75 : 2000)];
            });
            const f = ring[0]!, l = ring[ring.length - 1]!;
            if (f[0] !== l[0] || f[1] !== l[1])
                throw new StudioError('unclosed_ring', 'Close each ring by repeating its first coordinate. No vertices were changed.');
            return ring;
        });
    });
    const result: Geometry = raw.type === 'Polygon' ? { type: 'Polygon', coordinates: clean[0]! } : { type: 'MultiPolygon', coordinates: clean };
    if (space === 'local')
        validateTopology(result);
    return result;
}
export function mapGeometry(g: Geometry, fn: (p: Point) => Point): Geometry {
    return g.type === 'Polygon' ? { type: 'Polygon', coordinates: g.coordinates.map(r => r.map(fn)) } : { type: 'MultiPolygon', coordinates: g.coordinates.map(p => p.map(r => r.map(fn))) };
}
export function makeFrame(origin: Point): LocalFrame {
    finite(origin[0], 'Origin longitude', -180, 180);
    finite(origin[1], 'Origin latitude', -75, 75);
    return { kind: 'WGS84_ENU', origin: [...origin], horizontalUnit: 'm', verticalUnit: 'm', datum: 'WGS84 ellipsoid', radiusLimitM: 1000 };
}
function basis(frame: LocalFrame): {
    o: number[];
    east: number[];
    north: number[];
    up: number[];
} {
    const lon = radians(frame.origin[0]), lat = radians(frame.origin[1]);
    const sl = Math.sin(lat), cl = Math.cos(lat), so = Math.sin(lon), co = Math.cos(lon);
    const n = A / Math.sqrt(1 - E2 * sl * sl);
    return { o: [n * cl * co, n * cl * so, n * (1 - E2) * sl], east: [-so, co, 0], north: [-sl * co, -sl * so, cl], up: [cl * co, cl * so, sl] };
}
/** Geodetic -> geocentric -> local tangent plane, ellipsoid height = 0. */
export function toLocal(p: Point, frame: LocalFrame): Point {
    const lon = radians(p[0]), lat = radians(p[1]), sl = Math.sin(lat), cl = Math.cos(lat);
    const n = A / Math.sqrt(1 - E2 * sl * sl);
    const { o, east, north } = basis(frame);
    const diff = [n * cl * Math.cos(lon) - o[0]!, n * cl * Math.sin(lon) - o[1]!, n * (1 - E2) * sl - o[2]!];
    const x = diff.reduce((s, v, i) => s + v * east[i]!, 0), y = diff.reduce((s, v, i) => s + v * north[i]!, 0);
    if (Math.hypot(x, y) > frame.radiusLimitM || Math.abs(p[0] - frame.origin[0]) > 1 || Math.abs(p[1] - frame.origin[1]) > 1)
        throw new StudioError('site_extent', 'This local concept workspace supports sites within 1,000 metres of the origin, away from the antimeridian. Split the study into smaller sites.');
    return [x, y];
}
/** Intersect the ENU vertical line with the WGS84 ellipsoid, keeping the near root. */
export function toGeographic(p: Point, frame: LocalFrame): Point {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.hypot(...p) > frame.radiusLimitM)
        throw new StudioError('site_extent', 'Design coordinates exceed the local 1,000-metre workspace.');
    const { o, east, north, up } = basis(frame);
    const q = o.map((v, i) => v + p[0] * east[i]! + p[1] * north[i]!);
    const radii = [A * A, A * A, B * B];
    const aa = up.reduce((s, v, i) => s + v * v / radii[i]!, 0);
    const bb = 2 * up.reduce((s, v, i) => s + q[i]! * v / radii[i]!, 0);
    const cc = q.reduce((s, v, i) => s + v * v / radii[i]!, 0) - 1;
    const t = -2 * cc / (bb + Math.sqrt(bb * bb - 4 * aa * cc));
    const ecef = q.map((v, i) => v + t * up[i]!);
    return [degrees(Math.atan2(ecef[1]!, ecef[0]!)), degrees(Math.atan2(ecef[2]!, Math.hypot(ecef[0]!, ecef[1]!) * (1 - E2)))];
}
export function projectBoundary(g: Geometry, frame: LocalFrame): Geometry {
    return readGeometry(mapGeometry(readGeometry(g, 'geographic'), p => toLocal(p, frame)));
}
export function bounds(g: Geometry): {
    minX: number;
    minY: number;
    width: number;
    depth: number;
} {
    const ps = points(g);
    const xs = ps.map(p => p[0]), ys = ps.map(p => p[1]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    return { minX, minY, width: Math.max(...xs) - minX, depth: Math.max(...ys) - minY };
}
export function rectangle(width: number, depth: number, x = 0, y = 0, rotation = 0): Polygon {
    const r = radians(rotation), c = Math.cos(r), s = Math.sin(r);
    const ring: Ring = [[-width / 2, -depth / 2], [width / 2, -depth / 2], [width / 2, depth / 2], [-width / 2, depth / 2], [-width / 2, -depth / 2]];
    return { type: 'Polygon', coordinates: [ring.map(([a, b]) => [x + a * c - b * s, y + a * s + b * c])] };
}
/** Explicitly bounded implementation: NO concave/holed/multipart offset approximation. */
export function rectangularSetback(g: Geometry, distanceM: number): {
    status: 'computed' | 'empty' | 'not_evaluated';
    geometry: Geometry | null;
    note: string;
} {
    finite(distanceM, 'Uniform setback', 0, 500);
    if (distanceM === 0)
        return { status: 'computed', geometry: structuredClone(g), note: 'Zero uniform setback is a supplied assumption, not a zoning conclusion.' };
    const unsupported = { status: 'not_evaluated' as const, geometry: null, note: 'Constant-distance offsets for concave, holed, or multipart boundaries are not enabled. Install and validate the reviewed topology library; no centroid-scaled envelope is substituted.' };
    if (g.type !== 'Polygon' || g.coordinates.length !== 1 || g.coordinates[0]!.length !== 5)
        return unsupported;
    const ring = g.coordinates[0]!, a = ring[0]!, b = ring[1]!, c = ring[2]!, d = ring[3]!;
    const e0: Point = [b[0] - a[0], b[1] - a[1]], e1: Point = [c[0] - b[0], c[1] - b[1]];
    const w = Math.hypot(...e0), h = Math.hypot(...e1);
    if (w <= 0 || h <= 0 || Math.abs(e0[0] * e1[0] + e0[1] * e1[1]) > w * h * 1e-6 || Math.hypot(d[0] - (a[0] + e1[0]), d[1] - (a[1] + e1[1])) > 1e-4)
        return unsupported;
    if (w <= 2 * distanceM || h <= 2 * distanceM)
        return { status: 'empty', geometry: null, note: 'The supplied uniform setback eliminates all buildable area.' };
    const u: Point = [e0[0] / w, e0[1] / w], v: Point = [e1[0] / h, e1[1] / h];
    const p = (x: number, y: number): Point => [a[0] + u[0] * x + v[0] * y, a[1] + u[1] * x + v[1] * y];
    const inset: Polygon = { type: 'Polygon', coordinates: [[p(distanceM, distanceM), p(w - distanceM, distanceM), p(w - distanceM, h - distanceM), p(distanceM, h - distanceM), p(distanceM, distanceM)]] };
    return { status: 'computed', geometry: inset, note: 'Exact rectangular uniform setback in local metres. Front, side, and rear rules have not been assigned.' };
}
export function contains(container: Geometry, proposal: Geometry): boolean {
    for (const rings of components(proposal)) {
        for (const r of rings)
            for (let i = 0; i < r.length - 1; i++) {
                const a = r[i]!, b = r[i + 1]!;
                if (!inGeometry(a, container) || !inGeometry([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], container))
                    return false;
                if (components(container).some(c => c.some(edge => {
                    for (let j = 0; j < edge.length - 1; j++)
                        if (intersects(a, b, edge[j]!, edge[j + 1]!, true))
                            return true;
                    return false;
                })))
                    return false;
                // A boundary can enter and leave exactly at source vertices, without a
                // proper edge crossing. Check every resulting interval, not just one midpoint.
                const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
                const cuts = [0, 1, ...points(container).filter(p => onSegment(p, a, b)).map(p => ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)].sort((x, y) => x - y);
                for (let k = 0; k < cuts.length - 1; k++) {
                    const t = (cuts[k]! + cuts[k + 1]!) / 2;
                    if (!inGeometry([a[0] + t * dx, a[1] + t * dy], container))
                        return false;
                }
            }
    }
    // A proposal enclosing an excluded hole is not contained, even when no edges cross.
    for (const c of components(container))
        for (const hole of c.slice(1))
            if (inGeometry(hole[0]!, proposal, false))
                return false;
    return true;
}
/** Interior overlap, allowing touching edges. Bounded simple polygon predicates. */
export function overlaps(a: Geometry, b: Geometry): boolean {
    if (components(a).some(c => c.some(r => components(b).some(d => d.some(s => ringCrosses(r, s, true))))))
        return true;
    for (const [g, other] of [[a, b], [b, a]] as const) {
        if (points(g).some(p => inGeometry(p, other, false)))
            return true;
        // Coincident edges/polygons: sample just inside each outer edge.
        for (const poly of components(g)) {
            const ring = poly[0]!, sign = signedArea(ring) > 0 ? 1 : -1;
            for (let i = 0; i < ring.length - 1; i++) {
                const p = ring[i]!, q = ring[i + 1]!, dx = q[0] - p[0], dy = q[1] - p[1], length = Math.hypot(dx, dy);
                const test: Point = [(p[0] + q[0]) / 2 - sign * dy / length * 1e-7, (p[1] + q[1]) / 2 + sign * dx / length * 1e-7];
                if (inGeometry(test, g, false) && inGeometry(test, other, false))
                    return true;
            }
        }
    }
    return false;
}
