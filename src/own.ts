/** Lookup that ignores inherited keys, so names from user code like `toString` or `constructor` miss. */
export function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
