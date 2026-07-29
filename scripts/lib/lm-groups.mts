import { validateGrouping } from "./change-groups.mjs";
import type {
  ChangeGroup,
  ChangeGroupKind,
  ChangeGrouping,
  ChangeRisk,
  DependencyGraph,
  GroupedChange,
  GroupingDiagnostic,
  GroupingValidation,
} from "./change-groups.mjs";

export interface LmTitleEvidence {
  changeIds: string[];
  rationale: string;
}

export interface LmGroup {
  title: string;
  kind?: ChangeGroupKind;
  intent: string;
  risk: ChangeRisk;
  confidence: number;
  evidence: string[];
  reviewerChecks: string[];
  titleEvidence: LmTitleEvidence;
  changeIds: string[];
  changes?: GroupedChange[];
  readAfter?: string[];
}

export interface LmGroupingResult {
  groups: LmGroup[];
}

export interface LmGroupingCandidateGroup {
  title?: string;
  kind?: ChangeGroupKind;
  intent?: string;
  risk?: ChangeRisk;
  confidence?: number;
  evidence?: string[];
  reviewerChecks?: string[];
  titleEvidence?: Partial<LmTitleEvidence>;
  changeIds?: string[];
  changes?: GroupedChange[];
  readAfter?: string[];
}

export interface LmGroupingCandidate {
  groups?: LmGroupingCandidateGroup[];
}

export interface FinalizedLmGrouping extends Omit<ChangeGrouping, "groups" | "dependencyGraph"> {
  provenance: "lm";
  groups: Array<ChangeGroup & { titleEvidence: LmTitleEvidence }>;
  dependencyGraph: DependencyGraph;
}

const GENERIC_TITLE_RE =
  /^(definitions?|consumers?|definitions? and consumers?|associated tests?|configuration and build integration|needs inspection|unclassified|imports? and includes?|formatting-only changes?|generated dependency locks?|renames? without content changes?)$/i;

function candidateChanges(candidates: ChangeGrouping): Map<string, GroupedChange> {
  const changes = new Map<string, GroupedChange>();
  for (const group of candidates.groups || []) {
    for (const change of group.changes || []) changes.set(change.id, change);
  }
  for (const change of candidates.inventory || []) {
    if (!changes.has(change.id)) {
      changes.set(change.id, {
        ...change,
        label: change.hunk === null ? "metadata" : `hunk ${change.hunk + 1}`,
        topic: "Changed lines",
        definitions: [],
      });
    }
  }
  return changes;
}

export function validateLmGroupingResult(
  result: LmGroupingCandidate,
  candidates: Pick<ChangeGrouping, "inventory">,
): GroupingValidation {
  const diagnostics: GroupingDiagnostic[] = [];
  const expected = new Map((candidates.inventory || []).map((change) => [change.id, change]));
  const assigned = new Map<string, string>();
  const titles = new Map<string, LmGroupingCandidateGroup>();
  const groups = Array.isArray(result?.groups) ? result.groups : [];
  const repeatedAssignments = new Map<string, Set<string>>();
  const repeatedPattern = (changeId: string): string | null => {
    const suffix = changeId.slice(changeId.lastIndexOf("#") + 1);
    return /^(?:rp|rule)-[A-Za-z0-9_-]+$/.test(suffix) ? suffix : null;
  };

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
      typeof group?.risk !== "string" ||
      !["low", "medium", "high"].includes(group.risk) ||
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
    const repeatedPatterns = new Set(
      changeIds.map(repeatedPattern).filter((pattern): pattern is string => pattern !== null),
    );
    const includesResidual = changeIds.some((changeId) => repeatedPattern(changeId) === null);
    if (repeatedPatterns.size > 1 || (repeatedPatterns.size === 1 && includesResidual)) {
      diagnostics.push({
        level: "error",
        code: "mixed-repeated-pattern",
        group: groupLabel,
        message:
          "A deterministic repeated-change pattern must remain in its own dedicated mechanical group.",
      });
    }
    for (const pattern of repeatedPatterns) {
      const owners = repeatedAssignments.get(pattern) ?? new Set<string>();
      owners.add(groupLabel);
      repeatedAssignments.set(pattern, owners);
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
      const previousGroup = assigned.get(changeId);
      if (previousGroup !== undefined) {
        diagnostics.push({
          level: "error",
          code: "overlapping-change",
          change: changeId,
          groups: [previousGroup, groupLabel],
          message: `Change '${changeId}' is assigned more than once.`,
        });
      } else {
        assigned.set(changeId, groupLabel);
      }
    }
  }
  for (const [pattern, owners] of repeatedAssignments) {
    if (owners.size > 1) {
      diagnostics.push({
        level: "error",
        code: "split-repeated-pattern",
        change: pattern,
        groups: [...owners],
        message: `Repeated-change pattern '${pattern}' is split across semantic groups.`,
      });
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

export function finalizeLmGrouping(
  result: LmGroupingResult,
  candidates: ChangeGrouping,
): FinalizedLmGrouping {
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
  const groups: FinalizedLmGrouping["groups"] = result.groups.map((group, index) => ({
    id: `g${index + 1}`,
    title: group.title,
    kind: group.kind || "feature",
    intent: group.intent,
    risk: group.risk,
    confidence: group.confidence,
    evidence: group.evidence,
    reviewerChecks: group.reviewerChecks,
    titleEvidence: group.titleEvidence,
    changes: (group.changeIds ?? []).map((changeId) => {
      const change = changes.get(changeId);
      if (!change) throw new Error(`Validated change '${changeId}' is missing.`);
      return change;
    }),
  }));
  const explicitEdges: DependencyGraph["edges"] = result.groups.flatMap((group) =>
    (group.readAfter || []).map((prerequisite) => {
      const from = groupIds.get(prerequisite.toLowerCase());
      const to = groupIds.get(group.title.toLowerCase());
      if (!from || !to) throw new Error("Validated group dependency is missing.");
      return {
        from,
        to,
        reason: "semantic-prerequisite",
        evidence: `${group.title} is easier to review after ${prerequisite}.`,
      };
    }),
  );
  const finalGroupByChange = new Map<string, string>();
  for (const group of groups) {
    for (const change of group.changes) finalGroupByChange.set(change.id, group.id);
  }
  const candidateGroups = new Map((candidates.groups || []).map((group) => [group.id, group]));
  const finalGroupsForCandidate = (candidateGroupId: string): string[] => [
    ...new Set(
      (candidateGroups.get(candidateGroupId)?.changes || [])
        .map((change) => finalGroupByChange.get(change.id))
        .filter((groupId): groupId is string => groupId !== undefined),
    ),
  ];
  const inferredEdges: DependencyGraph["edges"] = [];
  for (const edge of candidates.dependencyGraph?.edges || []) {
    for (const from of finalGroupsForCandidate(edge.from)) {
      for (const to of finalGroupsForCandidate(edge.to)) {
        if (from !== to) inferredEdges.push({ ...edge, from, to });
      }
    }
  }
  const edgeMap = new Map<string, DependencyGraph["edges"][number]>();
  const outgoing = new Map(groups.map((group) => [group.id, new Set<string>()]));
  const addEdge = (edge: DependencyGraph["edges"][number]): void => {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.reason}`;
    if (edgeMap.has(key)) return;
    edgeMap.set(key, edge);
    outgoing.get(edge.from)?.add(edge.to);
  };
  const hasPath = (from: string, to: string, seen = new Set<string>()): boolean => {
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
  const linkedDefinitions = new Map(groups.map((group) => [group.id, new Set<string>()]));
  for (const edge of edges) {
    if (edge.reason === "definition-usage" && edge.evidence) {
      linkedDefinitions.get(edge.from)?.add(edge.evidence);
    }
  }
  const dependencies = new Map(groups.map((group) => [group.id, new Set<string>()]));
  for (const edge of edges) dependencies.get(edge.to)?.add(edge.from);
  const suggestedOrder: string[] = [];
  const remaining = new Set(groups.map((group) => group.id));
  while (remaining.size) {
    const ready = groups
      .map((group) => group.id)
      .filter(
        (id) =>
          remaining.has(id) &&
          [...(dependencies.get(id) || [])].every((dependency) => !remaining.has(dependency)),
      );
    if (!ready.length) {
      throw new Error(
        "Invalid LM grouping result: dependency-cycle: Group prerequisites contain a cycle.",
      );
    }
    for (const id of ready) {
      suggestedOrder.push(id);
      remaining.delete(id);
    }
  }
  const grouping: FinalizedLmGrouping = {
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
    validation: { valid: false, diagnostics: [] },
  };
  grouping.validation = validateGrouping(grouping, candidates.inventory);
  return grouping;
}
