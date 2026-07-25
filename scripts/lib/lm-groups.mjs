import { validateGrouping } from "./change-groups.mjs";

const GENERIC_TITLES = new Set(
  [
    "Definitions",
    "Consumers",
    "Configuration and build integration",
    "Associated tests",
    "Needs inspection",
    "Unclassified",
    "Imports and includes",
    "Formatting-only changes",
    "Generated dependency locks",
    "Renames without content changes",
  ].map((title) => title.toLowerCase()),
);

function candidateChanges(candidates) {
  const changes = new Map();
  for (const group of candidates.groups || []) {
    for (const change of group.changes || []) changes.set(change.id, change);
  }
  for (const change of candidates.inventory || []) {
    if (!changes.has(change.id)) changes.set(change.id, change);
  }
  return changes;
}

export function validateLmGroupingResult(result, candidates) {
  const diagnostics = [];
  const expected = new Map(
    (candidates.inventory || []).map((change) => [change.id, change]),
  );
  const assigned = new Map();
  const fileGroups = new Map();
  const titles = new Map();
  const groups = Array.isArray(result?.groups) ? result.groups : [];

  if (!groups.length) {
    diagnostics.push({
      level: "error",
      code: "missing-groups",
      message: "The LM result must contain at least one semantic change group.",
    });
  }

  for (const [index, group] of groups.entries()) {
    const title = String(group?.title || "").trim();
    const groupLabel = title || `group ${index + 1}`;
    if (!title) {
      diagnostics.push({
        level: "error",
        code: "missing-group-title",
        group: groupLabel,
        message: "Every semantic group needs a change-specific title.",
      });
    } else if (GENERIC_TITLES.has(title.toLowerCase())) {
      diagnostics.push({
        level: "error",
        code: "generic-group-title",
        group: groupLabel,
        message: `'${title}' is a classifier label, not a change-specific group title.`,
      });
    }
    if (titles.has(title.toLowerCase())) {
      diagnostics.push({
        level: "error",
        code: "duplicate-group-title",
        group: groupLabel,
        message: `Group title '${title}' is used more than once.`,
      });
    } else if (title) {
      titles.set(title.toLowerCase(), group);
    }

    if (
      !String(group?.intent || "").trim() ||
      !["low", "medium", "high"].includes(group?.risk) ||
      typeof group?.confidence !== "number" ||
      group.confidence < 0 ||
      group.confidence > 1 ||
      !Array.isArray(group?.evidence) ||
      !group.evidence.length ||
      !Array.isArray(group?.reviewerChecks) ||
      !group.reviewerChecks.length
    ) {
      diagnostics.push({
        level: "error",
        code: "incomplete-group-rationale",
        group: groupLabel,
        message:
          "Every group needs intent, low/medium/high risk, confidence from 0 to 1, evidence, and reviewer checks.",
      });
    }

    const changeIds = Array.isArray(group?.changeIds)
      ? group.changeIds
      : (group?.changes || []).map((change) => change.id);
    if (!changeIds.length) {
      diagnostics.push({
        level: "error",
        code: "missing-change-ids",
        group: groupLabel,
        message: "Every group must assign at least one candidate change unit.",
      });
      continue;
    }

    for (const changeId of changeIds) {
      const change = expected.get(changeId);
      if (!change) {
        diagnostics.push({
          level: "error",
          code: "unknown-change",
          group: groupLabel,
          change: changeId,
          message: `Group '${groupLabel}' references unknown change '${changeId}'.`,
        });
        continue;
      }
      if (assigned.has(changeId)) {
        diagnostics.push({
          level: "error",
          code: "overlapping-change",
          change: changeId,
          groups: [assigned.get(changeId), groupLabel],
          message: `Change '${changeId}' is assigned more than once.`,
        });
      } else {
        assigned.set(changeId, groupLabel);
      }
      if (!fileGroups.has(change.file)) fileGroups.set(change.file, new Set());
      fileGroups.get(change.file).add(groupLabel);
    }
  }

  for (const changeId of expected.keys()) {
    if (!assigned.has(changeId)) {
      diagnostics.push({
        level: "error",
        code: "unclassified-change",
        change: changeId,
        message: `Change '${changeId}' is not assigned to a semantic group.`,
      });
    }
  }
  for (const [file, groupNames] of fileGroups) {
    if (groupNames.size > 1) {
      diagnostics.push({
        level: "error",
        code: "split-file-across-groups",
        file,
        groups: [...groupNames],
        message: `'${file}' is split across multiple top-level groups.`,
      });
    }
  }
  for (const group of groups) {
    for (const prerequisite of group.readAfter || []) {
      if (!titles.has(String(prerequisite).toLowerCase())) {
        diagnostics.push({
          level: "error",
          code: "unknown-prerequisite",
          group: group.title,
          message: `Group '${group.title}' reads after unknown group '${prerequisite}'.`,
        });
      }
    }
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

export function finalizeLmGrouping(result, candidates) {
  const semanticValidation = validateLmGroupingResult(result, candidates);
  if (!semanticValidation.valid) {
    const details = semanticValidation.diagnostics
      .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
      .join("; ");
    throw new Error(`Invalid LM grouping result: ${details}`);
  }

  const changes = candidateChanges(candidates);
  const groupIds = new Map(
    result.groups.map((group, index) => [group.title.toLowerCase(), `g${index + 1}`]),
  );
  const groups = result.groups.map((group, index) => ({
    id: `g${index + 1}`,
    title: group.title,
    kind: group.kind || "feature",
    intent: group.intent,
    risk: group.risk,
    confidence: group.confidence,
    evidence: group.evidence,
    reviewerChecks: group.reviewerChecks,
    changes: group.changeIds.map((changeId) => changes.get(changeId)),
  }));
  const edges = result.groups.flatMap((group) =>
    (group.readAfter || []).map((prerequisite) => ({
      from: groupIds.get(prerequisite.toLowerCase()),
      to: groupIds.get(group.title.toLowerCase()),
      reason: "semantic-prerequisite",
      evidence: `${group.title} is easier to review after ${prerequisite}.`,
    })),
  );
  const grouping = {
    schemaVersion: 1,
    provenance: "lm",
    groups,
    dependencyGraph: {
      nodes: groups.map((group) => ({ id: group.id, definitions: [], role: group.kind })),
      edges,
      suggestedOrder: groups.map((group) => group.id),
    },
    inventory: candidates.inventory,
  };
  grouping.validation = validateGrouping(grouping, candidates.inventory);
  return grouping;
}
