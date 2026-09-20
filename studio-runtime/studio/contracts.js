export function parseIdentifier(value, label) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) {
        throw new TypeError(`${label} must be a bounded identifier.`);
    }
    return value;
}
export function parseVersionRef(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('A version reference is required.');
    const ref = value;
    return {
        projectId: parseIdentifier(ref['projectId'], 'projectId'),
        siteId: parseIdentifier(ref['siteId'], 'siteId'),
        scenarioId: parseIdentifier(ref['scenarioId'], 'scenarioId'),
        versionId: parseIdentifier(ref['versionId'], 'versionId'),
    };
}
export function sameVersion(left, right) {
    return left.projectId === right.projectId && left.siteId === right.siteId && left.scenarioId === right.scenarioId && left.versionId === right.versionId;
}
/** Abort is advisory. The epoch prevents a late response from changing a newly
 * selected project even when an upstream provider ignores cancellation. */
export class VersionRequestGuard {
    epoch = 0;
    controller = null;
    begin(ref) {
        this.invalidate();
        const epoch = this.epoch;
        const origin = parseVersionRef(ref);
        const controller = new AbortController();
        this.controller = controller;
        return { signal: controller.signal, isCurrent: active => this.epoch === epoch && !controller.signal.aborted && sameVersion(origin, active) };
    }
    invalidate() {
        this.epoch++;
        this.controller?.abort();
        this.controller = null;
    }
}
