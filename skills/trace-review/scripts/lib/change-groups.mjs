import path from "node:path";
import { decodeGitPath, parseDiffPaths } from "./preflight.mjs";
import { discoverRepeatedChanges, } from "./repeated-changes.mjs";
const LOCKFILES = new Set([
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "cargo.lock",
    "composer.lock",
    "poetry.lock",
    "gemfile.lock",
]);
const CONFIG_RE = /(^|\/)(cmakelists\.txt|makefile|dockerfile|[^/]+\.(cmake|ya?ml|toml|json|ini|cfg))$/i;
const TEST_RE = /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[^.]+$/i;
const IMPORT_RE = /^\s*(#\s*include\b|import\b|export\s+.+\s+from\b|from\s+\S+\s+import\b|require\s*\(|using\s+[\w:]+|use\s+[\w:]+|mod\s+\w+)/;
function normalizePath(value) {
    return String(value || "").replaceAll("\\", "/");
}
function parseRange(start, count) {
    const length = count === undefined ? 1 : Number(count);
    return {
        start: Number(start),
        end: length === 0 ? Number(start) : Number(start) + length - 1,
        count: length,
    };
}
function changeKey(change) {
    return change.id;
}
export function parsePatchChanges(text, preflight = {}) {
    const filesByPath = new Map((preflight.files || []).map((file) => [normalizePath(file.path), file]));
    const changes = [];
    const lines = String(text || "")
        .replace(/\r\n?/g, "\n")
        .split("\n");
    let file = null;
    let oldPath = null;
    let hunk = null;
    let hunkIndex = -1;
    let binary = false;
    let renamed = false;
    let oldLine = 0;
    let newLine = 0;
    const pushHunk = () => {
        if (!hunk)
            return;
        changes.push(hunk);
        hunk = null;
    };
    const pushMetadata = () => {
        pushHunk();
        if (!file || changes.some((change) => change.file === file))
            return;
        const facts = filesByPath.get(file);
        changes.push({
            id: `${file}#meta`,
            file,
            oldFile: oldPath || file,
            hunk: null,
            header: binary ? "Binary change" : renamed ? "Rename metadata" : "Metadata-only change",
            oldRange: null,
            newRange: null,
            hunks: [],
            rows: [],
            added: [],
            deleted: [],
            binary: binary || Boolean(facts?.binary),
            generated: Boolean(facts?.generated),
            fileType: facts?.type ?? "other",
            renamed,
        });
    };
    for (const line of lines) {
        let match;
        const diffPaths = parseDiffPaths(line);
        if (diffPaths) {
            pushMetadata();
            oldPath = normalizePath(diffPaths.oldPath);
            file = normalizePath(diffPaths.path);
            hunkIndex = -1;
            binary = false;
            renamed = oldPath !== file;
            continue;
        }
        if (!file)
            continue;
        if ((match = /^rename from (.+)$/.exec(line))) {
            oldPath = normalizePath(decodeGitPath(match[1]));
            renamed = true;
            continue;
        }
        if ((match = /^rename to (.+)$/.exec(line))) {
            file = normalizePath(decodeGitPath(match[1]));
            renamed = true;
            continue;
        }
        if (/^(GIT binary patch|Binary files? )/.test(line)) {
            binary = true;
            continue;
        }
        if ((match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line))) {
            pushHunk();
            hunkIndex++;
            const facts = filesByPath.get(file);
            hunk = {
                id: `${file}#h${hunkIndex}`,
                file,
                oldFile: oldPath || file,
                hunk: hunkIndex,
                header: match[5].trim(),
                oldRange: parseRange(match[1], match[2]),
                newRange: parseRange(match[3], match[4]),
                hunks: [hunkIndex],
                rows: [],
                added: [],
                deleted: [],
                binary: false,
                generated: Boolean(facts?.generated),
                fileType: facts?.type ?? "other",
                renamed,
            };
            oldLine = Number(match[1]);
            newLine = Number(match[3]);
            continue;
        }
        if (!hunk)
            continue;
        if (line.startsWith("+") && !line.startsWith("+++")) {
            hunk.added.push(line.slice(1));
            hunk.rows.push(`${file}#h${hunkIndex}:a${newLine++}`);
        }
        else if (line.startsWith("-") && !line.startsWith("---")) {
            hunk.deleted.push(line.slice(1));
            hunk.rows.push(`${file}#h${hunkIndex}:d${oldLine++}`);
        }
        else if (line.startsWith(" ")) {
            oldLine++;
            newLine++;
        }
    }
    pushMetadata();
    return changes;
}
function isLockfile(file) {
    return LOCKFILES.has(path.posix.basename(file).toLowerCase());
}
function isFormatting(change) {
    if (!change.added.length || !change.deleted.length)
        return false;
    const visibleLines = (lines) => lines.map((line) => line.trimStart()).filter((line) => line.trim());
    const added = visibleLines(change.added);
    const deleted = visibleLines(change.deleted);
    return added.length === deleted.length && added.every((line, index) => line === deleted[index]);
}
function changedLines(change) {
    return [...change.added, ...change.deleted].filter((line) => line.trim());
}
function isImportOnly(change) {
    const lines = changedLines(change);
    return lines.length > 0 && lines.every((line) => IMPORT_RE.test(line));
}
function rangeLabel(change) {
    if (!change.newRange)
        return "metadata";
    return `new lines ${change.newRange.start}-${change.newRange.end}`;
}
function topicOf(change) {
    if (change.header)
        return change.header;
    const candidate = [...change.added, ...change.deleted].map((line) => line.trim()).find(Boolean);
    if (!candidate)
        return change.hunk === null ? "File metadata" : "Changed lines";
    return candidate.length > 88 ? `${candidate.slice(0, 85)}…` : candidate;
}
function groupFacts(group) {
    const files = [...new Set(group.changes.map((change) => change.file))];
    const lines = group.changes.reduce((sum, change) => sum + change.added.length + change.deleted.length, 0);
    return { files, lines };
}
function makeGroup(id, title, kind, intent, risk, confidence, reviewerChecks, changes, evidence = []) {
    const facts = groupFacts({ changes });
    return {
        id,
        title,
        kind,
        intent,
        evidence: [
            `${changes.length} change unit${changes.length === 1 ? "" : "s"} across ${facts.files.length} file${facts.files.length === 1 ? "" : "s"}.`,
            ...evidence,
        ],
        risk,
        confidence,
        reviewerChecks,
        changes: changes.map((change) => ({
            id: change.id,
            file: change.file,
            hunk: change.hunk,
            hunks: change.hunks,
            rows: change.rows,
            oldRange: change.oldRange,
            newRange: change.newRange,
            label: rangeLabel(change),
            topic: topicOf(change),
            definitions: extractDefinitions(change),
        })),
    };
}
export function extractDefinedSymbols(lines) {
    const definitions = new Set();
    for (const line of lines) {
        const patterns = [
            /\b(?:class|interface|enum|struct|def|function)\s+([A-Za-z_$][\w$]*)/,
            /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
            /\b([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{/,
        ];
        for (const pattern of patterns) {
            const match = pattern.exec(line);
            if (match)
                definitions.add(match[1]);
        }
    }
    return [...definitions];
}
function extractDefinitions(change) {
    return extractDefinedSymbols(change.added);
}
function buildDependencyGraph(groups, changesById) {
    const nodeFacts = new Map();
    for (const group of groups) {
        const changes = group.changes
            .map((change) => changesById.get(change.id))
            .filter((change) => change !== undefined);
        const test = changes.every((change) => TEST_RE.test(change.file));
        nodeFacts.set(group.id, {
            // Test helpers are implementation details of verification, not concepts
            // that production groups should be ordered after.
            definitions: test ? [] : [...new Set(changes.flatMap(extractDefinitions))],
            text: changes.flatMap((change) => [...change.added, ...change.deleted]).join("\n"),
            config: changes.some((change) => CONFIG_RE.test(change.file)),
            test,
        });
    }
    const edges = [];
    const seen = new Set();
    const addEdge = (from, to, reason, evidence) => {
        if (from === to)
            return;
        const key = `${from}\u0000${to}\u0000${reason}`;
        if (seen.has(key))
            return;
        seen.add(key);
        edges.push({ from, to, reason, evidence });
    };
    for (const [sourceId, source] of nodeFacts) {
        for (const symbol of source.definitions) {
            const usage = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
            for (const [targetId, target] of nodeFacts) {
                if (usage.test(target.text))
                    addEdge(sourceId, targetId, "definition-usage", symbol);
            }
        }
    }
    const factsFor = (groupId) => {
        const facts = nodeFacts.get(groupId);
        if (!facts)
            throw new Error(`Missing dependency facts for '${groupId}'.`);
        return facts;
    };
    const substantive = groups.filter((group) => {
        const facts = factsFor(group.id);
        return !facts.config && !facts.test;
    });
    for (const group of groups) {
        const facts = factsFor(group.id);
        if (facts.config)
            substantive.forEach((target) => addEdge(target.id, group.id, "related-configuration", "Configuration/build integration"));
        if (facts.test)
            substantive.forEach((target) => addEdge(target.id, group.id, "associated-tests", "Verification follows implementation"));
    }
    const weight = (group) => {
        const facts = factsFor(group.id);
        if (facts.test)
            return 4;
        if (facts.config)
            return 3;
        if (facts.definitions.length)
            return 0;
        if (group.kind === "mechanical")
            return 2;
        return 1;
    };
    const suggestedOrder = groups
        .slice()
        .sort((a, b) => weight(a) - weight(b) || b.confidence - a.confidence || a.title.localeCompare(b.title))
        .map((group) => group.id);
    return {
        nodes: groups.map((group) => ({
            id: group.id,
            definitions: factsFor(group.id).definitions,
            role: factsFor(group.id).test
                ? "tests"
                : factsFor(group.id).config
                    ? "integration"
                    : factsFor(group.id).definitions.length
                        ? "definition"
                        : "consumer",
        })),
        edges,
        suggestedOrder,
    };
}
export function validateGrouping(grouping, inventory = []) {
    const diagnostics = [];
    const expected = new Set(inventory.map(changeKey));
    const assigned = new Map();
    for (const group of grouping.groups || []) {
        if (!group.intent ||
            !group.evidence?.length ||
            !group.risk ||
            typeof group.confidence !== "number" ||
            !group.reviewerChecks?.length) {
            diagnostics.push({
                level: "error",
                code: "incomplete-group-rationale",
                group: group.id,
                message: `Group '${group.id}' must include intent, evidence, risk, confidence, and reviewer checks.`,
            });
        }
        for (const change of group.changes || []) {
            const key = changeKey(change);
            const previousGroup = assigned.get(key);
            if (previousGroup !== undefined) {
                diagnostics.push({
                    level: "error",
                    code: "overlapping-change",
                    change: change.id,
                    groups: [previousGroup, group.id],
                    message: `Change '${change.id}' is assigned to both '${previousGroup}' and '${group.id}'.`,
                });
            }
            else {
                assigned.set(key, group.id);
            }
        }
    }
    for (const key of expected) {
        if (!assigned.has(key)) {
            diagnostics.push({
                level: "error",
                code: "unclassified-change",
                change: key.replace("\u0000", "#"),
                message: "Every change unit must be visible in exactly one group.",
            });
        }
    }
    for (const key of assigned.keys()) {
        if (expected.size && !expected.has(key)) {
            diagnostics.push({
                level: "error",
                code: "unknown-change",
                change: key.replace("\u0000", "#"),
                message: "A group references a change unit that is not present in the patch.",
            });
        }
    }
    return { valid: diagnostics.length === 0, diagnostics };
}
function rangeForAtoms(atoms, side) {
    const lines = atoms.filter((atom) => atom.side === side).map((atom) => atom.line);
    if (!lines.length)
        return null;
    return {
        start: Math.min(...lines),
        end: Math.max(...lines),
        count: lines.length,
    };
}
function changeFromAtoms(id, atoms, sources, topic) {
    const source = sources[0];
    const hunks = [...new Set(atoms.map((atom) => atom.hunk))].sort((a, b) => a - b);
    return {
        id,
        file: source.file,
        oldFile: source.oldFile,
        hunk: hunks.length === 1 ? hunks[0] : null,
        hunks,
        rows: atoms.map((atom) => atom.id),
        header: hunks.length === 1 ? source.header : topic,
        oldRange: rangeForAtoms(atoms, "delete"),
        newRange: rangeForAtoms(atoms, "add"),
        added: atoms.filter((atom) => atom.side === "add").map((atom) => atom.text),
        deleted: atoms.filter((atom) => atom.side === "delete").map((atom) => atom.text),
        binary: source.binary,
        generated: source.generated,
        fileType: source.fileType,
        renamed: source.renamed,
    };
}
function splitRepeatedChanges(text, hunks, options) {
    const discovery = discoverRepeatedChanges(text, {
        minimumFiles: options.minimumRepeatedFiles,
        rules: options.detectorRules,
    });
    const atomById = new Map(discovery.atoms.map((atom) => [atom.id, atom]));
    const sourceByRow = new Map();
    for (const change of hunks) {
        for (const row of change.rows)
            sourceByRow.set(row, change);
    }
    const repeated = [];
    for (const pattern of discovery.patterns) {
        const changes = [];
        for (const occurrence of pattern.occurrences) {
            const atoms = occurrence.atomIds
                .map((id) => atomById.get(id))
                .filter((atom) => atom !== undefined);
            const sources = occurrence.atomIds
                .map((id) => sourceByRow.get(id))
                .filter((change) => change !== undefined);
            if (atoms.length && sources.length) {
                changes.push(changeFromAtoms(`${occurrence.file}#${pattern.id}`, atoms, sources, pattern.title));
            }
        }
        if (changes.length)
            repeated.push({ pattern, changes });
    }
    const inventory = repeated.flatMap((entry) => entry.changes);
    for (const change of hunks) {
        if (!change.rows.length) {
            inventory.push(change);
            continue;
        }
        const remainingAtoms = change.rows
            .filter((row) => discovery.assignments[row] === undefined)
            .map((row) => atomById.get(row))
            .filter((atom) => atom !== undefined);
        if (!remainingAtoms.length)
            continue;
        inventory.push(changeFromAtoms(remainingAtoms.length === change.rows.length ? change.id : `${change.id}:residual`, remainingAtoms, [change], change.header));
    }
    return { inventory, repeated };
}
export function detectChangeGroups(text, preflight = {}, options = {}) {
    const parsedHunks = parsePatchChanges(text, preflight);
    const { inventory, repeated: repeatedPatterns } = splitRepeatedChanges(text, parsedHunks, options);
    const remaining = new Map(inventory.map((change) => [change.id, change]));
    const groups = [];
    let serial = 0;
    const take = (predicate) => {
        const found = [...remaining.values()].filter(predicate);
        found.forEach((change) => remaining.delete(change.id));
        return found;
    };
    const add = (title, kind, intent, risk, confidence, checks, changes, evidence) => {
        if (!changes.length)
            return;
        groups.push(makeGroup(`g${++serial}`, title, kind, intent, risk, confidence, checks, changes, evidence));
    };
    for (const { pattern, changes } of repeatedPatterns) {
        const unique = changes.filter((change) => remaining.has(change.id));
        unique.forEach((change) => remaining.delete(change.id));
        add(pattern.title, "mechanical", "Review one repeated edit pattern across every matching file.", "low", pattern.confidence, [
            "Confirm the inferred pattern describes every occurrence.",
            "Inspect any unmatched rows in the same files separately.",
        ], unique, [`${pattern.kind} pattern '${pattern.signature}' repeats across ${pattern.support} files.`]);
    }
    add("Renames without content changes", "mechanical", "Move files while preserving their contents.", "low", 0.99, ["Confirm destination paths and references are correct."], take((change) => change.renamed && change.hunk === null), ["Git reports rename metadata and no textual hunk."]);
    add("Generated dependency locks", "mechanical", "Refresh resolved dependency state.", "medium", 0.99, [
        "Confirm the lockfile was produced by the expected package manager.",
        "Compare dependency version changes with the manifest.",
    ], take((change) => isLockfile(change.file)), ["The path matches a known dependency lockfile."]);
    add("Formatting-only changes", "mechanical", "Change layout without changing non-whitespace tokens.", "low", 0.97, ["Spot-check that token order and string contents are unchanged."], take(isFormatting), ["Added and removed lines are identical after ignoring indentation-only differences."]);
    add("Imports and includes", "mechanical", "Update dependency declarations without changing executable statements.", "low", 0.93, ["Confirm imported symbols are used.", "Check dependency layering and include ordering."], take(isImportOnly), ["Every changed non-blank line matches an import, include, use, or using declaration."]);
    add("Needs inspection", "other", "Inspect changes whose content cannot be classified safely.", "high", 1, [
        "Review the underlying artifact or generation source.",
        "Decide whether the change is in scope.",
    ], take((change) => change.binary || change.generated), ["Binary or generated content is intentionally never hidden inside a mechanical group."]);
    add("Definitions", "feature", "Introduce or change the concepts that other changes may consume.", "medium", 0.82, ["Read these definitions before their usages.", "Check public contracts and compatibility."], take((change) => extractDefinitions(change).length > 0 &&
        !TEST_RE.test(change.file) &&
        !CONFIG_RE.test(change.file)), ["Added lines contain a deterministic class, function, type, or variable definition pattern."]);
    add("Consumers", "feature", "Update code that consumes definitions changed elsewhere in the patch.", "medium", 0.7, ["Trace each usage back to its definition.", "Check behavior and error paths at call sites."], take((change) => !TEST_RE.test(change.file) && !CONFIG_RE.test(change.file)), ["The change is executable source without a newly detected definition."]);
    add("Configuration and build integration", "other", "Connect the implementation to configuration, packaging, or build behavior.", "medium", 0.9, [
        "Confirm platform and environment variants.",
        "Check that names and paths match the implementation.",
    ], take((change) => CONFIG_RE.test(change.file)), ["The changed path matches a configuration or build-file convention."]);
    add("Associated tests", "test", "Verify the behavior introduced by the implementation groups.", "low", 0.95, [
        "Check that assertions would fail without the implementation.",
        "Look for uncovered edge and failure cases.",
    ], take((change) => TEST_RE.test(change.file)), ["The changed path matches a test directory or test/spec filename convention."]);
    add("Unclassified", "other", "Review substantive changes that do not match a deterministic mechanical rule.", "medium", 1, ["Identify the behavioral intent.", "Verify implementation, integration, and tests together."], [...remaining.values()], ["No deterministic mechanical classifier matched; the change remains fully visible."]);
    const changesById = new Map(inventory.map((change) => [change.id, change]));
    const dependencyGraph = buildDependencyGraph(groups, changesById);
    const result = {
        schemaVersion: 1,
        groups,
        dependencyGraph,
        inventory: inventory.map((change) => ({
            id: change.id,
            file: change.file,
            hunk: change.hunk,
            hunks: change.hunks,
            rows: change.rows,
            oldRange: change.oldRange,
            newRange: change.newRange,
        })),
        validation: { valid: false, diagnostics: [] },
    };
    result.validation = validateGrouping(result, inventory);
    return result;
}
