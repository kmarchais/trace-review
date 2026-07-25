import { validateGrouping } from "./change-groups.mjs";

const GENERIC_TITLE_RE =
  /^(definitions?|consumers?|definitions? and consumers?|associated tests?|configuration and build integration|needs inspection|unclassified|imports? and includes?|formatting-only changes?|generated dependency locks?|renames? without content changes?)$/i;

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
    } else if (GENERIC_TITLE_RE.test(title)) {
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
    const titleEvidenceIds = group?.titleEvidence?.changeIds;
    if (
      !group?.titleEvidence ||
      !Array.isArray(titleEvidenceIds) ||
      !titleEvidenceIds.length ||
      !String(group.titleEvidence.rationale || "").trim()
    ) {
      diagnostics.push({
        level: "error",
        code: "missing-title-evidence",
        group: groupLabel,
        message:
          "Every group title must cite assigned change IDs and explain how the title is grounded in those changes.",
      });
    } else {
      for (const changeId of titleEvidenceIds) {
        if (!changeIds.includes(changeId)) {
          diagnostics.push({
            level: "error",
            code: "unassigned-title-evidence",
            group: groupLabel,
            change: changeId,
            message: `Title evidence '${changeId}' is not assigned to '${groupLabel}'.`,
          });
        }
      }
    }
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
    titleEvidence: group.titleEvidence,
    changes: group.changeIds.map((changeId) => changes.get(changeId)),
  }));
  const explicitEdges = result.groups.flatMap((group) =>
    (group.readAfter || []).map((prerequisite) => ({
      from: groupIds.get(prerequisite.toLowerCase()),
      to: groupIds.get(group.title.toLowerCase()),
      reason: "semantic-prerequisite",
      evidence: `${group.title} is easier to review after ${prerequisite}.`,
    })),
  );
  const finalGroupByChange = new Map();
  for (const group of groups) {
    for (const change of group.changes) finalGroupByChange.set(change.id, group.id);
  }
  const candidateGroups = new Map(
    (candidates.groups || []).map((group) => [group.id, group]),
  );
  const finalGroupsForCandidate = (candidateGroupId) =>
    [
      ...new Set(
        (candidateGroups.get(candidateGroupId)?.changes || [])
          .map((change) => finalGroupByChange.get(change.id))
          .filter(Boolean),
      ),
    ];
  const inferredEdges = [];
  for (const edge of candidates.dependencyGraph?.edges || []) {
    for (const from of finalGroupsForCandidate(edge.from)) {
      for (const to of finalGroupsForCandidate(edge.to)) {
        if (from !== to) inferredEdges.push({ ...edge, from, to });
      }
    }
  }
  const edgeMap = new Map();
  const outgoing = new Map(groups.map((group) => [group.id, new Set()]));
  const addEdge = (edge) => {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.reason}`;
    if (edgeMap.has(key)) return;
    edgeMap.set(key, edge);
    outgoing.get(edge.from)?.add(edge.to);
  };
  const hasPath = (from, to, seen = new Set()) => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return [...(outgoing.get(from) || [])].some((next) => hasPath(next, to, seen));
  };
  explicitEdges.forEach(addEdge);
  for (const edge of inferredEdges) {
    if (!hasPath(edge.to, edge.from)) addEdge(edge);
  }
  const edges = [...edgeMap.values()];
  const linkedDefinitions = new Map(groups.map((group) => [group.id, new Set()]));
  for (const edge of edges) {
    if (edge.reason === "definition-usage" && edge.evidence) {
      linkedDefinitions.get(edge.from)?.add(edge.evidence);
    }
  }
  const dependencies = new Map(groups.map((group) => [group.id, new Set()]));
  for (const edge of edges) dependencies.get(edge.to)?.add(edge.from);
  const suggestedOrder = [];
  const remaining = new Set(groups.map((group) => group.id));
  while (remaining.size) {
    const ready = groups
      .map((group) => group.id)
      .filter(
        (id) =>
          remaining.has(id) &&
          [...(dependencies.get(id) || [])].every(
            (dependency) => !remaining.has(dependency),
          ),
      );
    if (!ready.length) {
      throw new Error("Invalid LM grouping result: dependency-cycle: Group prerequisites contain a cycle.");
    }
    for (const id of ready) {
      suggestedOrder.push(id);
      remaining.delete(id);
    }
  }
  const grouping = {
    schemaVersion: 1,
    provenance: "lm",
    groups,
    dependencyGraph: {
      nodes: groups.map((group) => {
        return {
          id: group.id,
          definitions: [...(linkedDefinitions.get(group.id) || [])],
          role: group.kind,
        };
      }),
      edges,
      suggestedOrder,
    },
    inventory: candidates.inventory,
  };
  grouping.validation = validateGrouping(grouping, candidates.inventory);
  return grouping;
}
