/** Lookup that ignores inherited keys, so names from user code like `toString` or `constructor` miss. */
export function own(record, key) {
    return Object.hasOwn(record, key) ? record[key] : undefined;
}
