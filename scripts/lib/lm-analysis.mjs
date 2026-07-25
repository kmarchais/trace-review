export const ANALYSIS_INPUT_VERSION = 1;
export const ANALYSIS_MODES = Object.freeze(["lm-analysis", "deep-audit"]);
const REQUIRED_FINDING_FIELDS = Object.freeze([
  "file",
  "line",
  "severity",
  "body",
  "confidence",
  "rationale",
]);
const FINDING_FIELDS = new Set(REQUIRED_FINDING_FIELDS);
const FINDING_SEVERITIES = new Set([
  "nit",
  "suggestion",
  "concern",
  "question",
  "praise",
  "comment",
]);
const VERDICTS = new Set(["approve", "comment", "request-changes"]);

function compactTarget(context) {
  const pullRequest = context.pullRequest || {};
  return {
    repository: context.repository?.nameWithOwner || "",
    branch: context.repository?.branch || "",
    headSha: context.repository?.headSha || "",
    number: pullRequest.number ?? null,
    url: pullRequest.url || "",
    title: pullRequest.title || context.repository?.branch || "Local changes",
    description: pullRequest.body || "",
    labels: pullRequest.labels || [],
    checks: pullRequest.checks || [],
    reviews: pullRequest.reviews || [],
    comments: pullRequest.comments || [],
    reviewComments: pullRequest.reviewComments || [],
  };
}

function diffReference(context, options) {
  if (context.diff && typeof context.diff === "object") {
    return {
      path: options.diffPath || context.diff.path,
      source: context.diff.source || context.source,
      bytes: context.diff.bytes ?? context.preflight?.totals?.bytes ?? 0,
    };
  }
  return {
    path: options.diffPath || "context.patch",
    source: context.source || "local",
    bytes: context.preflight?.totals?.bytes ?? 0,
  };
}

function requireDeterministicFacts(context) {
  const preflight = context?.preflight;
  if (
    !preflight ||
    preflight.patch?.valid !== true ||
    !preflight.totals ||
    !Array.isArray(preflight.files)
  ) {
    throw new Error("Focused analysis requires a valid preflight fact pack.");
  }
  const groups = context?.changeGroups;
  if (
    !groups ||
    groups.schemaVersion !== 1 ||
    groups.validation?.valid !== true ||
    !Array.isArray(groups.groups) ||
    !Array.isArray(groups.inventory)
  ) {
    throw new Error("Focused analysis requires valid candidate groups.");
  }
}

export function assessAnalysisRisk(context) {
  const reasons = [];
  const groups = context.changeGroups?.groups || [];
  const files = context.preflight?.files || [];
  const totals = context.preflight?.totals || {};
  if (context.preflight?.patch?.valid === false) reasons.push("Patch validation failed.");
  if (groups.some((group) => group.risk === "high")) reasons.push("At least one candidate group is high risk.");
  if (files.some((file) => file.binary)) reasons.push("The change includes binary content.");
  if (files.some((file) => file.generated)) reasons.push("The change includes generated content.");
  if ((totals.files || 0) > 100) reasons.push("The change touches more than 100 files.");
  if ((totals.additions || 0) + (totals.deletions || 0) > 3000) reasons.push("The textual change exceeds 3,000 lines.");
  if (reasons.length) return { level: "high", reasons };
  const medium = [];
  if (groups.some((group) => group.risk === "medium")) medium.push("At least one candidate group is medium risk.");
  if ((totals.files || 0) > 30) medium.push("The change touches more than 30 files.");
  return { level: medium.length ? "medium" : "low", reasons: medium };
}

export function prepareAnalysisInput(context, options = {}) {
  const mode = options.mode || "lm-analysis";
  if (!ANALYSIS_MODES.includes(mode)) {
    throw new Error(`Analysis mode must be one of: ${ANALYSIS_MODES.join(", ")}.`);
  }
  requireDeterministicFacts(context);
  const risk = assessAnalysisRisk(context);
  if (mode === "deep-audit" && !options.explicitDeepAudit && risk.level !== "high") {
    throw new Error("Deep-audit mode requires --explicit or a high-risk fact pack.");
  }
  return {
    schemaVersion: ANALYSIS_INPUT_VERSION,
    mode,
    risk,
    target: compactTarget(context),
    diff: diffReference(context, options),
    facts: {
      preflight: context.preflight,
      changeGroups: context.changeGroups,
    },
    findingContract: {
      maxFindings: Math.min(
        12,
        Math.max(3, Math.ceil((context.changeGroups?.inventory?.length || 0) / 5)),
      ),
      required: [...REQUIRED_FINDING_FIELDS],
      guidance: "Emit only actionable, verifiable findings. An empty findings array is valid.",
    },
  };
}

function requireValidAnalysisInput(input) {
  const problems = [];
  if (input?.schemaVersion !== ANALYSIS_INPUT_VERSION) {
    problems.push(`schemaVersion must be ${ANALYSIS_INPUT_VERSION}`);
  }
  if (!ANALYSIS_MODES.includes(input?.mode)) {
    problems.push(`mode must be one of: ${ANALYSIS_MODES.join(", ")}`);
  }
  if (problems.length) {
    throw new Error(`Invalid analysis input: ${problems.join("; ")}.`);
  }
  requireDeterministicFacts({
    preflight: input.facts?.preflight,
    changeGroups: input.facts?.changeGroups,
  });
}

export function validateAnalysisResult(result, input) {
  const diagnostics = [];
  const add = (code, path, message) => diagnostics.push({
    level: "error",
    code,
    path,
    message,
  });
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  if (!VERDICTS.has(result?.verdict)) {
    add("invalid-verdict", "verdict", "Use approve, comment, or request-changes.");
  }
  if (typeof result?.global !== "string" || !result.global.trim()) {
    add("missing-global-assessment", "global", "Analysis results require a global assessment.");
  }
  if (!Array.isArray(result?.findings)) {
    add("expected-findings", "findings", "Analysis results must include a findings array.");
  }
  const maxFindings = input?.findingContract?.maxFindings;
  if (Number.isInteger(maxFindings) && findings.length > maxFindings) {
    add(
      "finding-budget-exceeded",
      "findings",
      `Focused analysis allows at most ${maxFindings} findings for this change set; received ${findings.length}.`,
    );
  }
  findings.forEach((finding, index) => {
    const root = `findings[${index}]`;
    for (const field of Object.keys(finding || {})) {
      if (!FINDING_FIELDS.has(field)) {
        add(
          "unknown-finding-field",
          `${root}.${field}`,
          `Finding field '${field}' is not part of the review-spec contract.`,
        );
      }
    }
    if (typeof finding?.file !== "string" || !finding.file.trim()) {
      add("missing-finding-field", `${root}.file`, "A finding must identify a file.");
    }
    const validLine =
      (Number.isInteger(finding?.line) && finding.line > 0) ||
      (typeof finding?.line === "string" && /^o[1-9]\d*$/.test(finding.line));
    if (!validLine) {
      add("invalid-line-anchor", `${root}.line`, "Use a positive new line or an old-line anchor such as 'o7'.");
    } else {
      const oldSide = typeof finding.line === "string";
      const line = Number(oldSide ? finding.line.slice(1) : finding.line);
      const rangeKey = oldSide ? "oldRange" : "newRange";
      const anchored = (input?.facts?.changeGroups?.inventory || []).some(
        (change) =>
          change.file === finding.file &&
          change[rangeKey] &&
          change[rangeKey].count !== 0 &&
          line >= change[rangeKey].start &&
          line <= change[rangeKey].end,
      );
      if (!anchored) {
        add(
          "anchor-not-in-diff",
          `${root}.line`,
          `Finding anchor '${finding.file}:${finding.line}' is not inside a changed hunk range.`,
        );
      }
    }
    if (!FINDING_SEVERITIES.has(finding?.severity)) {
      add("invalid-severity", `${root}.severity`, "A finding must use a supported severity.");
    }
    if (typeof finding?.body !== "string" || !finding.body.trim()) {
      add("missing-finding-field", `${root}.body`, "A finding must explain the actionable issue.");
    }
    if (typeof finding?.confidence !== "number" || finding.confidence < 0 || finding.confidence > 1) {
      add("invalid-confidence", `${root}.confidence`, "Finding confidence must be a number from 0 to 1.");
    }
    if (typeof finding?.rationale !== "string" || !finding.rationale.trim()) {
      add("missing-rationale", `${root}.rationale`, "A finding must include a brief, verifiable rationale.");
    }
  });
  return { valid: diagnostics.length === 0, diagnostics };
}

export function analysisResultToReview(result, input) {
  requireValidAnalysisInput(input);
  const validation = validateAnalysisResult(result, input);
  if (!validation.valid) {
    const detail = validation.diagnostics
      .map((item) => `${item.path}: ${item.message}`)
      .join("; ");
    throw new Error(`Invalid LM analysis result: ${detail}`);
  }
  return {
    verdict: result.verdict,
    global: result.global,
    comments: result.findings,
  };
}
