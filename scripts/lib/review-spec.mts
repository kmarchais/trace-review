import fs from "node:fs";
import path from "node:path";

export const REVIEW_SPEC_VERSION = 1;
export const REVIEW_MODES = Object.freeze(["workspace", "lm-analysis", "deep-audit"] as const);
export type ReviewMode = (typeof REVIEW_MODES)[number];

type JsonObject = Record<string, unknown>;

export interface SpecDiagnostic {
  level: "error";
  code: string;
  path: string;
  message: string;
  hint?: string;
}

export interface SpecValidation {
  valid: boolean;
  schemaVersion: unknown;
  diagnostics: SpecDiagnostic[];
}

export interface ValidationOptions {
  baseDir?: string;
  checkFiles?: boolean;
}

const BLOCK_TYPES: ReadonlySet<unknown> = new Set([
  "prose",
  "diagram",
  "stats",
  "table",
  "callout",
  "heading",
]);
const BLOCK_WIDTHS: ReadonlySet<unknown> = new Set(["full", "two-thirds", "half", "third"]);
const GROUP_KINDS: ReadonlySet<unknown> = new Set([
  "mechanical",
  "refactor",
  "feature",
  "fix",
  "test",
  "docs",
  "other",
]);
const SEVERITIES: ReadonlySet<unknown> = new Set([
  "nit",
  "suggestion",
  "concern",
  "question",
  "praise",
  "comment",
]);
const VERDICTS: ReadonlySet<unknown> = new Set(["approve", "comment", "request-changes"]);

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateReviewSpec(spec: unknown, options: ValidationOptions = {}): SpecValidation {
  const diagnostics: SpecDiagnostic[] = [];
  const baseDir = path.resolve(options.baseDir || process.cwd());
  const checkFiles = options.checkFiles === true;

  const add = (code: string, fieldPath: string, message: string, hint?: string): void => {
    diagnostics.push({
      level: "error",
      code,
      path: fieldPath,
      message,
      ...(hint ? { hint } : {}),
    });
  };
  const requireString = (
    value: unknown,
    fieldPath: string,
    { allowEmpty = false }: { allowEmpty?: boolean } = {},
  ): value is string => {
    if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
      add(
        "expected-string",
        fieldPath,
        `Expected ${fieldPath} to be a${allowEmpty ? "" : " non-empty"} string.`,
      );
      return false;
    }
    return true;
  };
  const optionalString = (
    value: unknown,
    fieldPath: string,
    opts?: { allowEmpty?: boolean },
  ): boolean => value === undefined || requireString(value, fieldPath, opts);
  const enumValue = (value: unknown, values: ReadonlySet<unknown>, fieldPath: string): boolean => {
    if (!values.has(value)) {
      add(
        "invalid-enum",
        fieldPath,
        `Unsupported value '${String(value)}' at ${fieldPath}.`,
        `Use one of: ${[...values].join(", ")}.`,
      );
      return false;
    }
    return true;
  };
  const rejectUnknown = (value: unknown, allowed: ReadonlySet<string>, fieldPath: string): void => {
    if (!isObject(value)) return;
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        add(
          "unknown-field",
          fieldPath === "$" ? key : `${fieldPath}.${key}`,
          `Unknown field '${key}' at ${fieldPath}.`,
          "Remove the field or migrate to a schema version that defines it.",
        );
      }
    }
  };

  if (!isObject(spec)) {
    add("expected-object", "$", "The review specification must be a JSON object.");
    return { valid: false, schemaVersion: null, diagnostics };
  }
  rejectUnknown(
    spec,
    new Set(["schemaVersion", "mode", "title", "reviewId", "generated", "prs"]),
    "$",
  );

  if (spec.schemaVersion !== REVIEW_SPEC_VERSION) {
    add(
      spec.schemaVersion == null ? "missing-schema-version" : "unsupported-schema-version",
      "schemaVersion",
      spec.schemaVersion == null
        ? "The review specification is missing schemaVersion."
        : `Unsupported review specification schema version '${spec.schemaVersion}'.`,
      `Set schemaVersion to ${REVIEW_SPEC_VERSION}.`,
    );
  }
  if (typeof spec.mode !== "string" || !REVIEW_MODES.includes(spec.mode as ReviewMode)) {
    add(
      spec.mode == null ? "missing-mode" : "invalid-mode",
      "mode",
      spec.mode == null
        ? "The review specification is missing mode."
        : `Unknown review mode '${spec.mode}'.`,
      `Use one of: ${REVIEW_MODES.join(", ")}.`,
    );
  }

  optionalString(spec.title, "title");
  optionalString(spec.reviewId, "reviewId");
  optionalString(spec.generated, "generated");

  if (!Array.isArray(spec.prs) || spec.prs.length === 0) {
    add("missing-pull-requests", "prs", "Expected prs to contain at least one review target.");
    return { valid: false, schemaVersion: spec.schemaVersion ?? null, diagnostics };
  }

  const ids = new Set<string>();
  spec.prs.forEach((pr, index) => {
    const root = `prs[${index}]`;
    if (!isObject(pr)) {
      add("expected-object", root, `${root} must be an object.`);
      return;
    }
    rejectUnknown(
      pr,
      new Set([
        "id",
        "title",
        "url",
        "summary",
        "diff",
        "diffFile",
        "diagrams",
        "blocks",
        "groups",
        "groupFile",
        "changeGroups",
        "autoGroups",
        "review",
      ]),
      root,
    );
    requireString(pr.title, `${root}.title`);
    optionalString(pr.id, `${root}.id`);
    optionalString(pr.url, `${root}.url`);
    optionalString(pr.summary, `${root}.summary`, { allowEmpty: true });

    if (typeof pr.id === "string" && pr.id) {
      if (ids.has(pr.id))
        add("duplicate-pr-id", `${root}.id`, `Pull request id '${pr.id}' is duplicated.`);
      ids.add(pr.id);
    }

    const hasDiff = typeof pr.diff === "string";
    const hasDiffFile = typeof pr.diffFile === "string" && pr.diffFile.trim() !== "";
    if (hasDiff === hasDiffFile) {
      add(
        "invalid-diff-source",
        root,
        `${root} must define exactly one of diff or diffFile.`,
        "Use diffFile for normal reviews and inline diff only for small fixtures.",
      );
    } else if (hasDiffFile && checkFiles) {
      const diffFile = pr.diffFile as string;
      const diffPath = path.isAbsolute(diffFile) ? diffFile : path.resolve(baseDir, diffFile);
      if (!fs.existsSync(diffPath)) {
        add(
          "diff-file-not-found",
          `${root}.diffFile`,
          `Diff file '${pr.diffFile}' does not exist.`,
          `Resolved path: ${diffPath}`,
        );
      }
    }

    if (pr.blocks !== undefined) {
      if (!Array.isArray(pr.blocks)) {
        add("expected-array", `${root}.blocks`, `${root}.blocks must be an array.`);
      } else {
        pr.blocks.forEach((block, blockIndex) => {
          const blockPath = `${root}.blocks[${blockIndex}]`;
          if (!isObject(block)) {
            add("expected-object", blockPath, `${blockPath} must be an object.`);
            return;
          }
          rejectUnknown(
            block,
            new Set([
              "type",
              "width",
              "md",
              "text",
              "level",
              "title",
              "variant",
              "surface",
              "svg",
              "svgFile",
              "mermaid",
              "items",
              "headers",
              "rows",
            ]),
            blockPath,
          );
          if (!BLOCK_TYPES.has(block.type)) {
            add(
              "invalid-block-type",
              `${blockPath}.type`,
              `Unknown summary block type '${block.type}'.`,
              `Use one of: ${[...BLOCK_TYPES].join(", ")}.`,
            );
          }
          if (block.width !== undefined && !BLOCK_WIDTHS.has(block.width)) {
            add(
              "invalid-block-width",
              `${blockPath}.width`,
              `Unknown block width '${block.width}'.`,
              `Use one of: ${[...BLOCK_WIDTHS].join(", ")}.`,
            );
          }
          if (block.type === "diagram") {
            const sources = ["svg", "svgFile", "mermaid"].filter(
              (key) => typeof block[key] === "string" && block[key] !== "",
            );
            if (sources.length !== 1)
              add(
                "invalid-diagram-source",
                blockPath,
                `${blockPath} must define exactly one of svg, svgFile, or mermaid.`,
              );
          }
          if (block.type === "stats" && !Array.isArray(block.items))
            add("expected-array", `${blockPath}.items`, `${blockPath}.items must be an array.`);
          if (block.type === "table" && !Array.isArray(block.rows))
            add("expected-array", `${blockPath}.rows`, `${blockPath}.rows must be an array.`);
        });
      }
    }

    if (pr.diagrams !== undefined) {
      if (!Array.isArray(pr.diagrams)) {
        add("expected-array", `${root}.diagrams`, `${root}.diagrams must be an array.`);
      } else {
        pr.diagrams.forEach((diagram, diagramIndex) => {
          const diagramPath = `${root}.diagrams[${diagramIndex}]`;
          if (!isObject(diagram)) {
            add("expected-object", diagramPath, `${diagramPath} must be an object.`);
            return;
          }
          rejectUnknown(
            diagram,
            new Set(["title", "surface", "svg", "svgFile", "mermaid"]),
            diagramPath,
          );
          const sources = ["svg", "svgFile", "mermaid"].filter(
            (key) => typeof diagram[key] === "string" && diagram[key] !== "",
          );
          if (sources.length !== 1)
            add(
              "invalid-diagram-source",
              diagramPath,
              `${diagramPath} must define exactly one of svg, svgFile, or mermaid.`,
            );
          if (diagram.surface !== undefined)
            enumValue(diagram.surface, new Set(["light", "dark"]), `${diagramPath}.surface`);
        });
      }
    }

    if (pr.groups !== undefined) {
      if (!Array.isArray(pr.groups)) {
        add("expected-array", `${root}.groups`, `${root}.groups must be an array.`);
      } else {
        const groupIds = new Set<string>();
        const groupedFiles = new Map<string, string>();
        pr.groups.forEach((group, groupIndex) => {
          const groupPath = `${root}.groups[${groupIndex}]`;
          if (!isObject(group)) {
            add("expected-object", groupPath, `${groupPath} must be an object.`);
            return;
          }
          rejectUnknown(
            group,
            new Set(["id", "kind", "title", "note", "collapsed", "files"]),
            groupPath,
          );
          if (requireString(group.id, `${groupPath}.id`)) {
            if (groupIds.has(group.id))
              add(
                "duplicate-group-id",
                `${groupPath}.id`,
                `Group id '${group.id}' is duplicated within ${root}.`,
              );
            groupIds.add(group.id);
          }
          requireString(group.title, `${groupPath}.title`);
          if (group.kind !== undefined) enumValue(group.kind, GROUP_KINDS, `${groupPath}.kind`);
          if (!Array.isArray(group.files) || group.files.length === 0) {
            add(
              "missing-group-files",
              `${groupPath}.files`,
              `${groupPath}.files must contain at least one file path.`,
            );
          } else {
            group.files.forEach((file, fileIndex) => {
              const filePath = `${groupPath}.files[${fileIndex}]`;
              if (!requireString(file, filePath)) return;
              if (groupedFiles.has(file)) {
                add(
                  "overlapping-groups",
                  filePath,
                  `File '${file}' is assigned to both '${groupedFiles.get(file)}' and '${group.id || groupIndex}'.`,
                  "Assign each file to one group. Unlisted files remain visible under Other changes.",
                );
              } else {
                groupedFiles.set(
                  file,
                  typeof group.id === "string" && group.id ? group.id : String(groupIndex),
                );
              }
            });
          }
        });
      }
    }

    const groupSources = [
      pr.groups !== undefined && "groups",
      pr.groupFile !== undefined && "groupFile",
      pr.changeGroups !== undefined && "changeGroups",
      pr.autoGroups === true && "autoGroups",
    ].filter(Boolean);
    if (groupSources.length > 1) {
      add(
        "multiple-group-sources",
        root,
        `${root} defines multiple grouping sources: ${groupSources.join(", ")}.`,
        "Use one of groups, groupFile, changeGroups, or autoGroups.",
      );
    }
    if (pr.groupFile !== undefined) {
      if (requireString(pr.groupFile, `${root}.groupFile`) && checkFiles) {
        const groupPath = path.isAbsolute(pr.groupFile)
          ? (pr.groupFile as string)
          : path.resolve(baseDir, pr.groupFile as string);
        if (!fs.existsSync(groupPath)) {
          add(
            "group-file-not-found",
            `${root}.groupFile`,
            `Group file '${pr.groupFile}' does not exist.`,
            `Resolved path: ${groupPath}`,
          );
        }
      }
    }
    if (pr.changeGroups !== undefined) {
      if (!isObject(pr.changeGroups)) {
        add("expected-object", `${root}.changeGroups`, `${root}.changeGroups must be an object.`);
      } else if (pr.changeGroups.schemaVersion !== 1) {
        add(
          "unsupported-group-schema",
          `${root}.changeGroups.schemaVersion`,
          `Unsupported change-group schema version '${pr.changeGroups.schemaVersion}'.`,
          "Use change-group schema version 1.",
        );
      }
    }
    if (pr.autoGroups !== undefined && typeof pr.autoGroups !== "boolean") {
      add("expected-boolean", `${root}.autoGroups`, `${root}.autoGroups must be a boolean.`);
    }

    if (pr.review !== undefined) {
      if (!isObject(pr.review)) {
        add("expected-object", `${root}.review`, `${root}.review must be an object.`);
      } else {
        rejectUnknown(pr.review, new Set(["verdict", "global", "comments"]), `${root}.review`);
        if (pr.review.verdict !== undefined)
          enumValue(pr.review.verdict, VERDICTS, `${root}.review.verdict`);
        optionalString(pr.review.global, `${root}.review.global`, { allowEmpty: true });
        if (!Array.isArray(pr.review.comments)) {
          add(
            "expected-array",
            `${root}.review.comments`,
            `${root}.review.comments must be an array, including when it is empty.`,
          );
        } else {
          pr.review.comments.forEach((comment, commentIndex) => {
            const commentPath = `${root}.review.comments[${commentIndex}]`;
            if (!isObject(comment)) {
              add("expected-object", commentPath, `${commentPath} must be an object.`);
              return;
            }
            rejectUnknown(
              comment,
              new Set(["file", "line", "severity", "body", "confidence", "rationale"]),
              commentPath,
            );
            requireString(comment.file, `${commentPath}.file`);
            const validLine =
              typeof comment.line === "number" &&
              Number.isInteger(comment.line) &&
              comment.line > 0;
            const validOldLine =
              typeof comment.line === "string" && /^o[1-9]\d*$/.test(comment.line);
            if (!validLine && !validOldLine) {
              add(
                "invalid-line-anchor",
                `${commentPath}.line`,
                "Finding lines must be positive new-file integers or old-file anchors such as 'o7'.",
              );
            }
            if (comment.severity !== undefined)
              enumValue(comment.severity, SEVERITIES, `${commentPath}.severity`);
            requireString(comment.body, `${commentPath}.body`);
            requireString(comment.rationale, `${commentPath}.rationale`);
            if (
              typeof comment.confidence !== "number" ||
              comment.confidence < 0 ||
              comment.confidence > 1
            ) {
              add(
                "invalid-confidence",
                `${commentPath}.confidence`,
                "Finding confidence must be a number from 0 to 1.",
              );
            }
          });
        }
      }
    }

    if (spec.mode === "workspace" && pr.review !== undefined) {
      add(
        "review-not-allowed",
        `${root}.review`,
        "Workspace mode cannot contain LM findings.",
        "Use mode 'lm-analysis' or 'deep-audit', or remove the review object.",
      );
    }
    if ((spec.mode === "lm-analysis" || spec.mode === "deep-audit") && pr.review === undefined) {
      add(
        "review-required",
        `${root}.review`,
        `${spec.mode} mode requires a review object for every review target.`,
        "Use an empty comments array when there are no findings.",
      );
    }
  });

  return {
    valid: diagnostics.length === 0,
    schemaVersion: spec.schemaVersion ?? null,
    diagnostics,
  };
}

export function formatReviewSpecDiagnostics(validation: SpecValidation): string {
  return validation.diagnostics
    .map((item) => {
      const hint = item.hint ? `\n  Hint: ${item.hint}` : "";
      return `ERROR ${item.path} [${item.code}]: ${item.message}${hint}`;
    })
    .join("\n");
}
