export const TARGETS = ["node", "bun", "workers"];
export function isTarget(value) {
    return TARGETS.includes(value);
}
