export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}
