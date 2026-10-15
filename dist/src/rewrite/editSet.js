/**
 * Collects text edits against one source string.
 *
 * Nested rewrites are composed: when an outer rewrite asks for the text of a child range via
 * `textOf`, inner edits inside that range are applied to the returned text and consumed, so the
 * outer edit can safely replace the whole range. Remaining edits are applied back-to-front.
 */
export class EditSet {
    source;
    edits = [];
    consumed = new Set();
    nextId = 0;
    conflicts = [];
    constructor(source) {
        this.source = source;
    }
    add(edit) {
        this.edits.push({ ...edit, id: this.nextId++ });
    }
    /** Runs `fn`; if it returns false, edits consumed during the call are released again. */
    transaction(fn) {
        const snapshot = new Set(this.consumed);
        if (!fn())
            this.consumed = snapshot;
    }
    get size() {
        return this.edits.length - this.consumed.size;
    }
    get droppedEdits() {
        return this.conflicts;
    }
    /** Text of [start, end) with contained edits (plus `extra`) applied; contained edits are consumed. */
    textOf(start, end, extra = []) {
        const contained = this.edits.filter((e) => !this.consumed.has(e.id) && e.start >= start && e.end <= end && !(e.start === e.end && e.start === end));
        for (const e of contained)
            this.consumed.add(e.id);
        return applyEdits(this.source.slice(start, end), [...contained, ...extra].map((e) => ({ ...e, start: e.start - start, end: e.end - start })), this.conflicts);
    }
    apply() {
        return applyEdits(this.source, this.edits.filter((e) => !this.consumed.has(e.id)), this.conflicts);
    }
}
/** Applies non-overlapping edits back-to-front. Overlapping edits are skipped and recorded in `conflicts`. */
export function applyEdits(source, edits, conflicts = []) {
    const ordered = edits
        .map((edit, index) => ({ edit, index }))
        .sort((a, b) => b.edit.start - a.edit.start || b.edit.end - a.edit.end || b.index - a.index);
    let result = source;
    let floor = Number.POSITIVE_INFINITY;
    for (const { edit } of ordered) {
        if (edit.end > floor) {
            conflicts.push(edit);
            continue;
        }
        result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
        floor = edit.start;
    }
    return result;
}
