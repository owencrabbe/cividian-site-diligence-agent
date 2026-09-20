/** Shared anchors for Studio, calculations and exports. These are identifiers,
 * not authorization: the server must independently resolve project ownership. */
export interface VersionRef {
    projectId: string;
    siteId: string;
    scenarioId: string;
    versionId: string;
}
export type CapabilityState = 'available' | 'unconfigured' | 'unsupported' | 'quota_exhausted' | 'degraded' | 'permission_denied';
export interface Capability {
    state: CapabilityState;
    reason: string;
}
export function parseIdentifier(value: unknown, label: string): string {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) {
        throw new TypeError(`${label} must be a bounded identifier.`);
    }
    return value;
}
export function parseVersionRef(value: unknown): VersionRef {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('A version reference is required.');
    const ref = value as Record<string, unknown>;
    return {
        projectId: parseIdentifier(ref['projectId'], 'projectId'),
        siteId: parseIdentifier(ref['siteId'], 'siteId'),
        scenarioId: parseIdentifier(ref['scenarioId'], 'scenarioId'),
        versionId: parseIdentifier(ref['versionId'], 'versionId'),
    };
}
export function sameVersion(left: VersionRef, right: VersionRef): boolean {
    return left.projectId === right.projectId && left.siteId === right.siteId && left.scenarioId === right.scenarioId && left.versionId === right.versionId;
}
/** Abort is advisory. The epoch prevents a late response from changing a newly
 * selected project even when an upstream provider ignores cancellation. */
export class VersionRequestGuard {
    private epoch = 0;
    private controller: AbortController | null = null;
    begin(ref: VersionRef): { signal: AbortSignal; isCurrent: (active: VersionRef) => boolean } {
        this.invalidate();
        const epoch = this.epoch;
        const origin = parseVersionRef(ref);
        const controller = new AbortController();
        this.controller = controller;
        return { signal: controller.signal, isCurrent: active => this.epoch === epoch && !controller.signal.aborted && sameVersion(origin, active) };
    }
    invalidate(): void {
        this.epoch++;
        this.controller?.abort();
        this.controller = null;
    }
}
