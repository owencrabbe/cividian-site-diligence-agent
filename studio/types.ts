import type { ArchitectureAppearance } from './architecture.js';
import type { FinanceAssumptions } from './finance.js';
/** Studio schema v1. All horizontal/vertical design distances are metres.
 * Geographic coordinates are WGS84 [longitude, latitude], never a point-as-parcel.
 */
export type Point = [
    number,
    number
];
export type Ring = Point[];
export type Polygon = {
    type: 'Polygon';
    coordinates: Ring[];
};
export type MultiPolygon = {
    type: 'MultiPolygon';
    coordinates: Ring[][];
};
export type Geometry = Polygon | MultiPolygon;
export type Mode = 'site_capacity' | 'existing_building_concept';
export type BoundaryBasis = 'example' | 'user_sketch' | 'user_import' | 'mapped_footprint' | 'provider_reference' | 'unknown';
export interface Evidence {
    basis: BoundaryBasis | 'design_assumption' | 'user_interpretation' | 'user_entered_rule';
    source: string;
    reference: string | null;
    retrievedAt: string | null;
    effectiveAt: string | null;
    review: 'unreviewed';
    note: string;
}
export interface LocalFrame {
    kind: 'WGS84_ENU';
    origin: Point;
    horizontalUnit: 'm';
    verticalUnit: 'm';
    datum: 'WGS84 ellipsoid';
    radiusLimitM: 1000;
}
/** User-entered identity evidence, frozen with a scenario; not provider verification. */
export interface PropertyIdentity {
    schema: 'studio.property-identity.v1';
    city: string | null;
    state: string | null;
    address: string | null;
    parcelId: string | null;
    siteReference: string | null;
    point: Point | null;
    source: { label: string | null; url: string | null; retrievedAt: string | null } | null;
    review: { status: 'unreviewed' | 'user_confirmed'; at: string | null };
    note: string;
}
export interface StudioSite {
    surroundings?: { id: string; geometry: Geometry; heightM: number | null; source: string }[];
    selectedBuilding?: { id: string; heightM: number | null; source: string };
    identity?: PropertyIdentity;
    id: string;
    projectId: string | null;
    label: string;
    boundaryKind: 'site_boundary' | 'building_footprint';
    originalGeometry: Geometry;
    frame: LocalFrame;
    evidence: Evidence;
    parcelReferences: string[];
}
export type RuleType = 'height' | 'stories' | 'far' | 'uniform_setback' | 'use' | 'access' | 'environment';
export interface Constraint {
    id: string;
    type: RuleType;
    value: number | null;
    unit: 'm' | 'ratio' | 'stories' | 'none';
    applicability: 'site' | 'not_applicable' | 'unknown';
    evidence: Evidence;
}
export interface ConstraintSet {
    id: string;
    rules: Constraint[];
}
export interface PhysicalAssumptions {
    id: string;
    efficiency: number;
    unitAreaM2: number;
    parkingPerUnit: number;
    areaPerParkingSpaceM2: number;
}
export type ProgramUse = 'residential' | 'retail' | 'office';
export interface DesignObject {
    /** Optional and versioned; absent on legacy models. Never an as-built claim. */
    appearance?: ArchitectureAppearance;
    id: string;
    name: string;
    shape: 'bar' | 'l_shape' | 'mapped';
    mappedGeometry?: Geometry;
    widthM: number;
    depthM: number;
    wingM: number;
    xM: number;
    yM: number;
    rotationDeg: number;
    stories: number;
    storyHeightM: number;
    upperStepbackM: number;
    use: ProgramUse;
    groundUse: ProgramUse;
}
export interface Plate {
    id: string;
    objectId: string;
    /** One-based floor number. */
    level: number;
    /** Height above the scenario flat-pad base, not absolute elevation. */
    baseM: number;
    heightM: number;
    geometry: Geometry;
    use: ProgramUse;
}
export interface StudioSnapshot {
    schema: 'studio.scenario.v1';
    finance?: FinanceAssumptions;
    scenarioId: string;
    versionId: string;
    parentId: string | null;
    name: string;
    mode: Mode;
    site: StudioSite;
    objects: DesignObject[];
    constraints: ConstraintSet;
    assumptions: PhysicalAssumptions;
    baseElevationM: number;
    terrainBasis: 'flat_pad_assumption';
    createdAt: string;
    author: string | null;
    legacyReference: string | null;
    note: string;
}
export interface GeometryQuantities {
    scenarioId: string;
    scenarioVersionId: string;
    assumptionVersionId: string;
    formulaVersion: 'studio.plates.v1';
    areaUnit: 'm2';
    lengthUnit: 'm';
    siteAreaM2: number;
    proposedGrossAreaM2: number;
    estimatedNetAreaM2: number;
    groundCoverageM2: number | null;
    /** Unavailable for existing-building mode: a footprint is not a site area. */
    achievedFar: number | null;
    allowableFarAreaM2: number | null;
    maxHeightM: number;
    areaByUseM2: Record<ProgramUse, number>;
    estimatedUnits: number;
    estimatedParkingSpaces: number;
    estimatedParkingAreaM2: number;
    residualSiteAreaM2: number | null;
    basis: 'proposed_geometry';
    boundaryBasis: Evidence['basis'];
    limitations: string[];
}
export type CheckState = 'within_supplied_limit' | 'exceeds_supplied_limit' | 'unknown' | 'not_evaluated' | 'not_applicable';
export interface ConstraintCheck {
    ruleId: string;
    label: string;
    state: CheckState;
    proposed: number | null;
    limit: number | null;
    delta: number | null;
    unit: string;
    objectIds: string[];
    note: string;
}
export interface Analysis {
    plates: Plate[];
    siteGeometry: Geometry;
    envelope: {
        status: 'computed' | 'empty' | 'not_evaluated';
        geometry: Geometry | null;
        note: string;
    };
    quantities: GeometryQuantities;
    checks: ConstraintCheck[];
}
export interface CalculationReference {
    status: 'complete' | 'partial' | 'unavailable';
    scenarioVersionId: string;
    assumptionVersionId: string;
    runId: string | null;
    outputs: Readonly<Record<string, {
        value: number;
        unit: string;
        formula: string;
    }>>;
    note: string;
}
export interface EconomicsAdapter {
    calculate(quantities: GeometryQuantities, signal: AbortSignal): Promise<CalculationReference>;
}
export interface StudioCommand {
    schema: 'studio.command.v1';
    scenarioId: string;
    baseVersionId: string;
    operation: 'add_story' | 'set_dimensions' | 'translate' | 'rotate' | 'set_ground_use' | 'set_stepback';
    objectId: string;
    args: Record<string, unknown>;
}
export interface ReviewEvent {
    id: string;
    versionId: string;
    commentId: string;
    action: 'comment' | 'resolve' | 'reopen';
    text: string;
    objectId: string | null;
    createdAt: string;
    author: string;
}
