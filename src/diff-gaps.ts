export interface DiffLineCoordinates {
  o?: number;
  n?: number;
}

export function partitionRowsAtLineGaps<T extends DiffLineCoordinates>(rows: readonly T[]): T[][] {
  const segments: T[][] = [];
  let segment: T[] = [];
  let previousOld: number | undefined;
  let previousNew: number | undefined;

  for (const row of rows) {
    const oldGap = row.o !== undefined && previousOld !== undefined && row.o > previousOld + 1;
    const newGap = row.n !== undefined && previousNew !== undefined && row.n > previousNew + 1;
    if ((oldGap || newGap) && segment.length) {
      segments.push(segment);
      segment = [];
    }
    segment.push(row);
    if (row.o !== undefined) previousOld = row.o;
    if (row.n !== undefined) previousNew = row.n;
  }

  if (segment.length) segments.push(segment);
  return segments;
}
