export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function requiredValue(argv, index, option) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`${option} requires a value`);
    }
    return value;
}
export function parseJson(text) {
    return JSON.parse(text);
}
