export class GithubReviewPublicationError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = "GithubReviewPublicationError";
    }
}
function objectValue(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positiveInteger(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function fallbackReason(comment) {
    if (comment.fallbackReason)
        return comment.fallbackReason;
    if (comment.kind !== "line")
        return `${comment.kind} comments do not have a diff anchor`;
    if (comment.anchorStatus === "orphaned")
        return "the saved diff anchor is no longer present";
    if (comment.anchorStatus === "stale")
        return "the saved diff anchor belongs to an older PR head";
    return "the comment does not have a complete GitHub diff anchor";
}
function fallbackLocation(comment) {
    if (!comment.path)
        return undefined;
    if (!positiveInteger(comment.line))
        return comment.path;
    const range = positiveInteger(comment.startLine) && comment.startLine !== comment.line
        ? `${comment.startLine}-${comment.line}`
        : String(comment.line);
    return `${comment.path}:${range} (${comment.side || "unknown side"})`;
}
function nativeComment(comment) {
    if (comment.kind !== "line" ||
        Boolean(comment.fallbackReason) ||
        comment.anchorStatus !== "current" ||
        !comment.path ||
        !comment.body.trim() ||
        !positiveInteger(comment.line) ||
        (comment.side !== "LEFT" && comment.side !== "RIGHT") ||
        (comment.startLine !== undefined &&
            (!positiveInteger(comment.startLine) ||
                comment.startLine > comment.line ||
                (comment.startSide !== undefined && comment.startSide !== comment.side)))) {
        return null;
    }
    const native = {
        path: comment.path,
        body: comment.body.trim(),
        side: comment.side,
        line: comment.line,
    };
    if (positiveInteger(comment.startLine) && comment.startLine !== comment.line) {
        native.start_side = comment.startSide || comment.side;
        native.start_line = comment.startLine;
    }
    return native;
}
export function parseGithubReviewPlan(value) {
    if (!objectValue(value) || value.schemaVersion !== 1) {
        throw new Error("The publication plan must use schemaVersion 1.");
    }
    const target = value.target;
    if (!objectValue(target) ||
        typeof target.repository !== "string" ||
        !/^[^/\s]+\/[^/\s]+$/.test(target.repository) ||
        !positiveInteger(target.pullRequest) ||
        typeof target.headSha !== "string" ||
        !target.headSha.trim() ||
        typeof target.url !== "string" ||
        !target.url.trim()) {
        throw new Error("The publication plan has an invalid GitHub target.");
    }
    if (typeof value.summary !== "string" ||
        !Array.isArray(value.nativeComments) ||
        !Array.isArray(value.fallbackComments)) {
        throw new Error("The publication plan must contain a summary and comment arrays.");
    }
    for (const [index, comment] of value.nativeComments.entries()) {
        if (!objectValue(comment) ||
            typeof comment.path !== "string" ||
            !comment.path.trim() ||
            typeof comment.body !== "string" ||
            !comment.body.trim() ||
            (comment.side !== "LEFT" && comment.side !== "RIGHT") ||
            !positiveInteger(comment.line) ||
            (comment.start_line !== undefined && !positiveInteger(comment.start_line)) ||
            (positiveInteger(comment.start_line) && comment.start_line > comment.line) ||
            (comment.start_side !== undefined &&
                comment.start_side !== "LEFT" &&
                comment.start_side !== "RIGHT") ||
            (comment.start_side !== undefined && comment.start_side !== comment.side)) {
            throw new Error(`Native comment ${index + 1} has an invalid diff anchor.`);
        }
    }
    for (const [index, comment] of value.fallbackComments.entries()) {
        if (!objectValue(comment) ||
            !["general", "file", "line"].includes(String(comment.kind)) ||
            typeof comment.body !== "string" ||
            !comment.body.trim() ||
            typeof comment.reason !== "string" ||
            !comment.reason.trim()) {
            throw new Error(`Fallback comment ${index + 1} is invalid.`);
        }
    }
    if (!value.summary.trim() &&
        value.nativeComments.length === 0 &&
        value.fallbackComments.length === 0) {
        throw new Error("The publication plan does not contain a review.");
    }
    return value;
}
export function prepareGithubReview(context, draft) {
    const nativeComments = [];
    const fallbackComments = [];
    for (const comment of draft.comments) {
        const native = nativeComment(comment);
        if (native) {
            nativeComments.push(native);
            continue;
        }
        if (!comment.body.trim())
            continue;
        fallbackComments.push({
            kind: comment.kind,
            body: comment.body.trim(),
            ...(comment.path ? { path: comment.path } : {}),
            ...(fallbackLocation(comment) ? { location: fallbackLocation(comment) } : {}),
            reason: fallbackReason(comment),
        });
    }
    return {
        schemaVersion: 1,
        target: context,
        summary: draft.summary.trim(),
        nativeComments,
        fallbackComments,
    };
}
export function githubReviewPreview(plan) {
    const lines = [
        `Target: ${plan.target.repository}#${plan.target.pullRequest}`,
        `Head: ${plan.target.headSha}`,
        `Native threads: ${plan.nativeComments.length}`,
        `Summary fallbacks: ${plan.fallbackComments.length}`,
        "",
        "Review body:",
        githubReviewBody(plan),
    ];
    for (const comment of plan.nativeComments) {
        const range = comment.start_line
            ? `${comment.start_line}-${comment.line}`
            : String(comment.line);
        lines.push("", `Native ${comment.path}:${range} (${comment.side}):`, comment.body);
    }
    for (const comment of plan.fallbackComments) {
        lines.push("", `Fallback ${comment.location || "overall"} — ${comment.reason}:`, comment.body);
    }
    return lines.join("\n");
}
export function githubReviewBody(plan) {
    let body = plan.summary;
    if (plan.fallbackComments.length) {
        body += `${body ? "\n\n" : ""}## Comments included in this summary\n`;
        for (const comment of plan.fallbackComments) {
            const location = comment.location ? `**${comment.location}** — ` : "";
            body += `\n- ${location}${comment.body}\n  _Fallback: ${comment.reason}._`;
        }
    }
    return body.trim() || "Inline review comments.";
}
export async function publishGithubReview(plan, options) {
    if (!(await options.publisher.isAuthenticated())) {
        throw new GithubReviewPublicationError("authentication-required", "GitHub authentication is required before publishing a review.");
    }
    const currentHead = await options.publisher.currentHead(plan.target);
    if (currentHead !== plan.target.headSha) {
        throw new GithubReviewPublicationError("stale-head", `The pull request head changed from ${plan.target.headSha} to ${currentHead}. Regenerate the review before publishing.`);
    }
    const preview = githubReviewPreview(plan);
    if (!(await options.confirm(plan, preview))) {
        return {
            status: "cancelled",
            nativeComments: plan.nativeComments.length,
            fallbackComments: plan.fallbackComments.length,
        };
    }
    try {
        const published = await options.publisher.createReview(plan.target, {
            commit_id: plan.target.headSha,
            event: "COMMENT",
            body: githubReviewBody(plan),
            comments: plan.nativeComments,
        });
        return {
            status: "published",
            ...(published.url ? { url: published.url } : {}),
            nativeComments: plan.nativeComments.length,
            fallbackComments: plan.fallbackComments.length,
        };
    }
    catch (error) {
        throw new GithubReviewPublicationError("publication-failed", `GitHub rejected the review: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
}
