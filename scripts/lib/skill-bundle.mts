import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { deflateRawSync, inflateRawSync } from "node:zlib";

export const SKILL_BUNDLE_SOURCE_FILES = Object.freeze([
  "LICENSE",
  "SKILL.md",
  "REVIEW-SPEC.md",
  "docs/LIMITATIONS.md",
  "docs/REAL-PR-METRICS.md",
  "docs/REPOSITORY-CONFIGURATION.md",
  "examples/diagram.svg",
  "examples/pr-1.groups.json",
  "examples/pr-1.patch",
  "examples/review-spec.json",
]);

export const SKILL_BUNDLE_RUNTIME_FILES = Object.freeze([
  "schemas/review-spec.v1.schema.json",
  "scripts/build-review.mjs",
  "scripts/collect-pr-context.mjs",
  "scripts/detect-mechanical-groups.mjs",
  "scripts/finalize-lm-analysis.mjs",
  "scripts/finalize-lm-groups.mjs",
  "scripts/prepare-lm-analysis.mjs",
  "scripts/publish-github-review.mjs",
  "scripts/review-preflight.mjs",
  "scripts/validate-review-spec.mjs",
  "scripts/lib/cli.mjs",
  "scripts/lib/change-groups.mjs",
  "scripts/lib/github-review.mjs",
  "scripts/lib/lm-analysis.mjs",
  "scripts/lib/lm-groups.mjs",
  "scripts/lib/pr-context.mjs",
  "scripts/lib/preflight.mjs",
  "scripts/lib/review-spec.mjs",
  "templates/review.template.html",
]);

export const SKILL_BUNDLE_FILES = Object.freeze([
  ...SKILL_BUNDLE_SOURCE_FILES,
  ...SKILL_BUNDLE_RUNTIME_FILES,
]);

const SKILL_BUNDLE_SOURCE_PATHS: Readonly<Record<string, string>> = Object.freeze({
  "SKILL.md": "SKILL.source.md",
});

interface ZipEntry {
  name: string;
  data: Buffer;
}

interface SkillFile {
  relativePath: string;
  data: Buffer;
}

const BINARY_DISTRIBUTION_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp", ".zip"]);

export interface SkillDistributionDiff {
  missing: string[];
  changed: string[];
  unexpected: string[];
}

function walkFiles(directory: string, root = directory): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? walkFiles(entryPath, root)
      : [path.relative(root, entryPath).replaceAll(path.sep, "/")];
  });
}

function readSkillFiles(root: string, runtimeRoot: string): SkillFile[] {
  return SKILL_BUNDLE_FILES.map((relativePath) => {
    const sourceRoot = SKILL_BUNDLE_RUNTIME_FILES.includes(
      relativePath as (typeof SKILL_BUNDLE_RUNTIME_FILES)[number],
    )
      ? runtimeRoot
      : root;
    const source = path.join(sourceRoot, SKILL_BUNDLE_SOURCE_PATHS[relativePath] ?? relativePath);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error(`Missing bundle input: ${relativePath}`);
    }
    const data = BINARY_DISTRIBUTION_EXTENSIONS.has(path.extname(source).toLowerCase())
      ? fs.readFileSync(source)
      : Buffer.from(fs.readFileSync(source, "utf8").replace(/\r\n?/g, "\n"));
    return {
      relativePath,
      data,
    };
  });
}

export function inspectSkillDistribution({
  root,
  runtimeRoot = path.join(root, "dist", "runtime"),
  skillRoot = path.join(root, "skills", "trace-review"),
}: {
  root: string;
  runtimeRoot?: string;
  skillRoot?: string;
}): SkillDistributionDiff {
  const expected = new Map(
    readSkillFiles(root, runtimeRoot).map((file) => [file.relativePath, file.data]),
  );
  const actual = new Set(walkFiles(skillRoot));
  const missing: string[] = [];
  const changed: string[] = [];

  for (const [relativePath, data] of expected) {
    if (!actual.has(relativePath)) {
      missing.push(relativePath);
    } else if (!fs.readFileSync(path.join(skillRoot, relativePath)).equals(data)) {
      changed.push(relativePath);
    }
  }

  return {
    missing,
    changed,
    unexpected: [...actual].filter((relativePath) => !expected.has(relativePath)).sort(),
  };
}

export function syncSkillDistribution({
  root,
  runtimeRoot = path.join(root, "dist", "runtime"),
  skillRoot = path.join(root, "skills", "trace-review"),
}: {
  root: string;
  runtimeRoot?: string;
  skillRoot?: string;
}): string[] {
  const files = readSkillFiles(root, runtimeRoot);
  fs.rmSync(skillRoot, { recursive: true, force: true });
  for (const file of files) {
    const destination = path.join(skillRoot, file.relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.data);
  }
  return files.map((file) => file.relativePath);
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[n] = value >>> 0;
}

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(name: Buffer, data: Buffer, packed: Buffer, crc: number): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x0021, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(packed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  return header;
}

function centralHeader(
  name: Buffer,
  data: Buffer,
  packed: Buffer,
  crc: number,
  offset: number,
): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x0021, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(packed.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(offset, 42);
  return header;
}

function createZip(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const packed = deflateRawSync(entry.data, { level: 9 });
    const local = localHeader(name, entry.data, packed, crc);
    const central = centralHeader(name, entry.data, packed, crc, offset);
    localParts.push(local, name, packed);
    centralParts.push(central, name);
    offset += local.length + name.length + packed.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

export function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("Invalid bundle archive: end record not found.");

  const count = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Invalid bundle archive: central directory is malformed.");
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const packedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Invalid bundle archive: local entry is missing for ${name}.`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const packed = buffer.subarray(dataOffset, dataOffset + packedSize);
    if (method !== 0 && method !== 8) {
      throw new Error(`Invalid bundle archive: unsupported compression for ${name}.`);
    }
    const data = method === 8 ? inflateRawSync(packed) : packed;
    if (data.length !== size || crc32(data) !== expectedCrc) {
      throw new Error(`Invalid bundle archive: checksum mismatch for ${name}.`);
    }
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function listZipEntries(buffer: Buffer): string[] {
  return [...readZipEntries(buffer).keys()];
}

function runSmokeTest(bundleRoot: string): void {
  const spec = path.join(bundleRoot, "examples", "review-spec.json");
  const outputDir = path.join(bundleRoot, ".smoke");
  const output = path.join(outputDir, "review.html");
  fs.mkdirSync(outputDir);

  const commands: string[][] = [
    ["scripts/validate-review-spec.mjs", "--spec", spec],
    ["scripts/build-review.mjs", "--spec", spec, "--out", output],
  ];
  for (const command of commands) {
    const executable = command[0];
    if (!executable) throw new Error("Bundle smoke test command is empty.");
    const result = spawnSync("node", [path.join(bundleRoot, executable), ...command.slice(1)], {
      cwd: bundleRoot,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`Bundle smoke test failed:\n${result.stdout}${result.stderr}`);
    }
  }

  if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
    throw new Error("Bundle smoke test did not produce a review document.");
  }
}

export function buildSkillBundle({
  root,
  runtimeRoot = path.join(root, "dist", "runtime"),
  outDir,
}: {
  root: string;
  runtimeRoot?: string;
  outDir: string;
}): { archive: string; entries: string[] } {
  const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-bundle-"));
  const bundleRoot = path.join(stageParent, "trace-review");
  fs.mkdirSync(bundleRoot);

  try {
    const entries = readSkillFiles(root, runtimeRoot).map((file): ZipEntry => {
      const relativePath = file.relativePath;
      const destination = path.join(bundleRoot, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.data);
      return {
        name: `trace-review/${relativePath.replaceAll(path.sep, "/")}`,
        data: file.data,
      };
    });

    runSmokeTest(bundleRoot);
    fs.mkdirSync(outDir, { recursive: true });
    const archive = path.join(outDir, "trace-review-skill.zip");
    fs.writeFileSync(archive, createZip(entries));
    return { archive, entries: entries.map((entry) => entry.name) };
  } finally {
    fs.rmSync(stageParent, { recursive: true, force: true });
  }
}
