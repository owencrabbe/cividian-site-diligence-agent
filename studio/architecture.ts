import { components, StudioError, finite } from './geometry.js';
import type { DesignObject, Plate } from './types.js';

export const ARCHITECTURE_STYLES = ['heritage_brick', 'limestone', 'warm_modern'] as const;
export type ArchitectureStyle = typeof ARCHITECTURE_STYLES[number];
export interface ArchitectureAppearance {
    schema: 'studio.appearance.v1';
    style: ArchitectureStyle;
    bayWidthM: number;
    glazingRatio: number;
}
export interface FacadeBay {
    objectId: string;
    level: number;
    edge: number;
    index: number;
    start: [number, number];
    direction: [number, number];
    inward: [number, number];
    lengthM: number;
    baseM: number;
    heightM: number;
    openingWidthM: number;
    sillM: number;
    openingHeightM: number;
    entrance: boolean;
    storefront: boolean;
}
export const DEFAULT_APPEARANCE: Readonly<ArchitectureAppearance> = Object.freeze({
    schema: 'studio.appearance.v1', style: 'heritage_brick', bayWidthM: 3.2, glazingRatio: .48,
});
export function parseAppearance(input: unknown): ArchitectureAppearance {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new StudioError('appearance', 'Architectural appearance must be an object.');
    const r = input as Record<string, unknown>;
    if (r['schema'] !== 'studio.appearance.v1' || !ARCHITECTURE_STYLES.includes(r['style'] as ArchitectureStyle)) throw new StudioError('appearance', 'Choose a supported architectural style.');
    return { schema: 'studio.appearance.v1', style: r['style'] as ArchitectureStyle,
        bayWidthM: finite(r['bayWidthM'], 'Facade bay width', 2, 6),
        glazingRatio: finite(r['glazingRatio'], 'Facade opening width ratio', .25, .72) };
}
/** One bounded facade description from the SAME floor polygons as underwriting.
 * Details are proposed, not a reconstruction of an existing property. Edge zero
 * is an assumed entrance elevation, not detected street frontage. */
export function facadeBays(object: DesignObject, plates: readonly Plate[]): FacadeBay[] {
    const appearance = object.appearance ?? DEFAULT_APPEARANCE;
    const result: FacadeBay[] = [];
    for (const plate of plates.filter(p => p.objectId === object.id)) {
        for (const rings of components(plate.geometry)) for (const [ringIndex, ring] of rings.entries()) {
        let signedArea = 0;
        for (let i = 0; i < ring.length - 1; i++) signedArea += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
        for (let edge = 0; edge < ring.length - 1; edge++) {
            const p = ring[edge]!, q = ring[edge + 1]!, length = Math.hypot(q[0] - p[0], q[1] - p[1]);
            if (length < .01) continue;
            const direction: [number, number] = [(q[0] - p[0]) / length, (q[1] - p[1]) / length];
            const sign = (signedArea >= 0 ? 1 : -1) * (ringIndex === 0 ? 1 : -1);
            const inward: [number, number] = [-direction[1] * sign, direction[0] * sign];
            const count = Math.max(1, Math.ceil(length / appearance.bayWidthM));
            const width = length / count, storefront = plate.level === 1 && plate.use !== 'residential';
            const openingWidth = width < 1.35 ? 0 : Math.min(width - .5, width * (storefront ? .8 : appearance.glazingRatio));
            for (let i = 0; i < count; i++) {
                const entrance = ringIndex === 0 && plate.level === 1 && edge === 0 && i === Math.floor(count / 2) && openingWidth > 0;
                const sill = entrance || storefront ? .12 : Math.min(.88, plate.heightM * .27);
                const topMargin = Math.min(.85, plate.heightM * .24);
                result.push({ objectId: object.id, level: plate.level, edge, index: i,
                    start: [p[0] + direction[0] * width * i, p[1] + direction[1] * width * i],
                    direction, inward, lengthM: width, baseM: plate.baseM, heightM: plate.heightM,
                    openingWidthM: openingWidth, sillM: sill, openingHeightM: plate.heightM - sill - topMargin, entrance, storefront });
                if (result.length > 6000) throw new StudioError('architecture_budget', 'This building exceeds detailed-view capacity. Reduce its size or bay density; plan and massing remain available.');
            }
        }
    }
    }
    return result;
}
