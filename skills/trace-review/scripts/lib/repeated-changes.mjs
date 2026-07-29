import { createHash } from "node:crypto";
import { parseDiffPaths } from "./preflight.mjs";
function objectValue(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return value;
}
export function parseDetectorRuleSet(value) {
    const root = objectValue(value, "Detector rule set");
    if (root.schemaVersion !== 1)
        throw new Error("Detector rule set schemaVersion must be 1.");
    if (!Array.isArray(root.rules))
        throw new Error("Detector rule set rules must be an array.");
    if (root.rules.length > 64)
        throw new Error("Detector rule sets cannot exceed 64 rules.");
    const ids = new Set();
    const rules = root.rules.map((candidate, ruleIndex) => {
        const rule = objectValue(candidate, `rules[${ruleIndex}]`);
        const id = typeof rule.id === "string" ? rule.id.trim() : "";
        const title = typeof rule.title === "string" ? rule.title.trim() : "";
        if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
            throw new Error(`rules[${ruleIndex}].id must use letters, numbers, underscores, or dashes.`);
        }
        if (ids.has(id))
            throw new Error(`Detector rule id '${id}' is duplicated.`);
        ids.add(id);
        if (!title)
            throw new Error(`rules[${ruleIndex}].title is required.`);
        if (!Array.isArray(rule.operations) || !rule.operations.length) {
            throw new Error(`rules[${ruleIndex}].operations must contain at least one operation.`);
        }
        if (rule.operations.length > 32) {
            throw new Error(`rules[${ruleIndex}].operations cannot exceed 32 entries.`);
        }
        const operations = rule.operations.map((candidateOperation, operationIndex) => {
            const operation = objectValue(candidateOperation, `rules[${ruleIndex}].operations[${operationIndex}]`);
            if (operation.side !== "add" && operation.side !== "delete") {
                throw new Error(`rules[${ruleIndex}].operations[${operationIndex}].side must be add or delete.`);
            }
            const side = operation.side;
            const pattern = typeof operation.pattern === "string" ? operation.pattern.trim() : "";
            if (!pattern) {
                throw new Error(`rules[${ruleIndex}].operations[${operationIndex}].pattern is required.`);
            }
            if (pattern.length > 1_000) {
                throw new Error(`rules[${ruleIndex}].operations[${operationIndex}].pattern cannot exceed 1000 characters.`);
            }
            if (operation.location !== undefined &&
                !["start", "end", "any"].includes(String(operation.location))) {
                throw new Error(`rules[${ruleIndex}].operations[${operationIndex}].location must be start, end, or any.`);
            }
            return {
                side,
                pattern,
                ...(operation.location === undefined
                    ? {}
                    : { location: operation.location }),
            };
        });
        const minimumFiles = rule.minimumFiles === undefined ? undefined : Number(rule.minimumFiles);
        if (minimumFiles !== undefined &&
            (!Number.isInteger(minimumFiles) || minimumFiles < 2 || minimumFiles > 10_000)) {
            throw new Error(`rules[${ruleIndex}].minimumFiles must be an integer from 2 to 10000.`);
        }
        return { id, title, ...(minimumFiles === undefined ? {} : { minimumFiles }), operations };
    });
    return { schemaVersion: 1, rules };
}
function patternId(signature) {
    return `rp-${createHash("sha256").update(signature).digest("hex").slice(0, 12)}`;
}
function parseEditAtoms(patch) {
    const atoms = [];
    const lines = String(patch || "")
        .replace(/\r\n?/g, "\n")
        .split("\n");
    let file = "";
    let hunk = -1;
    let oldLine = 0;
    let newLine = 0;
    let fileStatus = "modified";
    for (const raw of lines) {
        const paths = parseDiffPaths(raw);
        if (paths) {
            file = paths.path.replaceAll("\\", "/");
            hunk = -1;
            fileStatus = "modified";
            continue;
        }
        if (raw.startsWith("new file mode ") || raw === "--- /dev/null") {
            fileStatus = "added";
            continue;
        }
        if (raw.startsWith("deleted file mode ") || raw === "+++ /dev/null") {
            fileStatus = "deleted";
            continue;
        }
        const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (header) {
            oldLine = Number(header[1]);
            newLine = Number(header[2]);
            hunk++;
            continue;
        }
        if (!file || hunk < 0)
            continue;
        if (raw.startsWith("+") && !raw.startsWith("+++")) {
            atoms.push({
                id: `${file}#h${hunk}:a${newLine}`,
                file,
                hunk,
                side: "add",
                line: newLine++,
                text: raw.slice(1),
                fileStatus,
            });
        }
        else if (raw.startsWith("-") && !raw.startsWith("---")) {
            atoms.push({
                id: `${file}#h${hunk}:d${oldLine}`,
                file,
                hunk,
                side: "delete",
                line: oldLine++,
                text: raw.slice(1),
                fileStatus,
            });
        }
        else if (raw.startsWith(" ")) {
            oldLine++;
            newLine++;
        }
    }
    return atoms;
}
function normalizedExact(atom) {
    const text = atom.text.trim();
    if (!text)
        return null;
    return `${atom.side}\u0000${text}`;
}
function lowInformationExact(signature) {
    return /^[{}()[\],;:.\-+*/]+$/.test(signature.split("\u0000")[1] || "");
}
function tokenizeForPattern(text) {
    const values = text.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s]/g) || [];
    return values.map((value) => ({
        value,
        type: /^[A-Za-z_$][\w$]*$/.test(value)
            ? "identifier"
            : /^\d/.test(value)
                ? "number"
                : /^["']/.test(value)
                    ? "string"
                    : "punctuation",
    }));
}
function tokenShape(atom) {
    const tokens = tokenizeForPattern(atom.text);
    if (!tokens.length)
        return null;
    return {
        key: `${atom.side}\u0000${tokens
            .map((token) => (token.type === "punctuation" ? token.value : `<${token.type}>`))
            .join("\u0001")}`,
        tokens,
    };
}
function parameterizedPattern(candidates) {
    const rows = candidates.map((atom) => tokenizeForPattern(atom.text));
    if (!rows.length || rows.some((tokens) => tokens.length !== rows[0].length))
        return null;
    const pattern = [];
    const variablePositions = [];
    let stableIdentifiers = 0;
    let serial = 0;
    for (let index = 0; index < rows[0].length; index++) {
        const values = rows.map((tokens) => tokens[index].value);
        if (values.every((value) => value === values[0])) {
            pattern.push(values[0]);
            if (rows[0][index].type === "identifier")
                stableIdentifiers++;
            continue;
        }
        const types = rows.map((tokens) => tokens[index].type);
        if (!types.every((type) => type === types[0]) || types[0] === "punctuation")
            return null;
        const name = `${types[0]}${++serial}`;
        pattern.push(`$${name}`);
        variablePositions.push({ index, name });
    }
    if (!variablePositions.length || stableIdentifiers === 0)
        return null;
    const bindings = new Map();
    candidates.forEach((atom, rowIndex) => {
        bindings.set(atom.id, Object.fromEntries(variablePositions.map(({ index, name }) => [name, rows[rowIndex][index].value])));
    });
    return {
        signature: `${candidates[0].side}\u0000${pattern.join(" ")}`,
        bindings,
        specificity: stableIdentifiers,
    };
}
function titleForExact(signature) {
    const [side, text] = signature.split("\u0000");
    return side === "add" ? `Repeat ${text}` : `Repeated removal of ${text}`;
}
function matchesLocation(atom, location, lastHunk) {
    if (!location || location === "any")
        return true;
    if (location === "start")
        return atom.line <= 12;
    return atom.hunk === lastHunk;
}
function matchRulePattern(atom, pattern, bindings) {
    const actual = tokenizeForPattern(atom.text);
    const expected = tokenizeForPattern(pattern);
    if (actual.length !== expected.length)
        return null;
    const next = { ...bindings };
    for (let index = 0; index < expected.length; index++) {
        const wanted = expected[index].value;
        const received = actual[index].value;
        if (/^\$[A-Za-z_]\w*$/.test(wanted)) {
            const name = wanted.slice(1);
            if (next[name] !== undefined && next[name] !== received)
                return null;
            next[name] = received;
        }
        else if (wanted !== received) {
            return null;
        }
    }
    return next;
}
function ruleOccurrence(atoms, rule) {
    const lastHunk = Math.max(...atoms.map((atom) => atom.hunk));
    let steps = 0;
    const search = (operationIndex, used, bindings) => {
        steps++;
        if (steps > 50_000) {
            throw new Error(`Detector rule '${rule.id}' exceeded its evaluation budget in '${atoms[0]?.file || "unknown file"}'.`);
        }
        if (operationIndex === rule.operations.length)
            return { atomIds: [], bindings: { ...bindings } };
        const operation = rule.operations[operationIndex];
        for (const atom of atoms) {
            if (used.has(atom.id) ||
                atom.side !== operation.side ||
                !matchesLocation(atom, operation.location, lastHunk)) {
                continue;
            }
            const matched = matchRulePattern(atom, operation.pattern, bindings);
            if (!matched)
                continue;
            const tail = search(operationIndex + 1, new Set([...used, atom.id]), matched);
            if (tail)
                return { atomIds: [atom.id, ...tail.atomIds], bindings: tail.bindings };
        }
        return null;
    };
    return search(0, new Set(), {});
}
function applyRules(atoms, rules, assignments) {
    const byFile = new Map();
    for (const atom of atoms) {
        if (atom.fileStatus !== "modified")
            continue;
        const rows = byFile.get(atom.file) ?? [];
        rows.push(atom);
        byFile.set(atom.file, rows);
    }
    const patterns = [];
    for (const rule of rules) {
        if (!rule.id.trim() || !rule.title.trim() || !rule.operations.length)
            continue;
        const occurrences = [];
        for (const [file, fileAtoms] of byFile) {
            const available = fileAtoms.filter((atom) => assignments[atom.id] === undefined);
            const occurrence = ruleOccurrence(available, rule);
            if (occurrence)
                occurrences.push({ file, ...occurrence });
        }
        const minimumFiles = Math.max(2, rule.minimumFiles ?? 2);
        if (occurrences.length < minimumFiles)
            continue;
        const id = `rule-${rule.id.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
        const signature = JSON.stringify(rule.operations);
        patterns.push({
            id,
            kind: "rule",
            title: rule.title,
            signature,
            support: occurrences.length,
            files: occurrences.map((occurrence) => occurrence.file),
            confidence: 0.96,
            occurrences,
        });
        for (const atomId of occurrences.flatMap((occurrence) => occurrence.atomIds)) {
            assignments[atomId] = id;
        }
    }
    return patterns;
}
function mergeRepeatedReplacements(patterns, atoms, assignments) {
    const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
    const consumed = new Set();
    const merged = [];
    const sameFiles = (left, right) => left.files.length === right.files.length &&
        left.files.every((file, index) => file === right.files[index]);
    const sideOf = (pattern) => {
        const side = pattern.signature.split("\u0000")[0];
        return side === "add" || side === "delete" ? side : null;
    };
    const occurrenceFor = (pattern, file) => pattern.occurrences.find((occurrence) => occurrence.file === file);
    const replacementKey = (pattern) => {
        const firstAtomId = pattern.occurrences[0]?.atomIds[0];
        const firstAtom = firstAtomId ? atomById.get(firstAtomId) : undefined;
        const shape = firstAtom ? tokenShape(firstAtom)?.key.split("\u0000")[1] : undefined;
        return shape === undefined ? null : `${pattern.files.join("\u0001")}\u0000${shape}`;
    };
    const additionsByKey = new Map();
    for (const pattern of patterns) {
        if (pattern.kind === "rule" || sideOf(pattern) !== "add")
            continue;
        const key = replacementKey(pattern);
        if (!key)
            continue;
        const candidates = additionsByKey.get(key) ?? [];
        candidates.push(pattern);
        additionsByKey.set(key, candidates);
    }
    for (const deletion of patterns) {
        if (consumed.has(deletion.id) || deletion.kind === "rule" || sideOf(deletion) !== "delete") {
            continue;
        }
        const key = replacementKey(deletion);
        if (!key)
            continue;
        const addition = (additionsByKey.get(key) || []).find((candidate) => {
            if (consumed.has(candidate.id) ||
                candidate.kind === "rule" ||
                sideOf(candidate) !== "add" ||
                !sameFiles(deletion, candidate)) {
                return false;
            }
            return deletion.files.every((file) => {
                const deletedOccurrence = occurrenceFor(deletion, file);
                const addedOccurrence = occurrenceFor(candidate, file);
                if (deletedOccurrence?.atomIds.length !== 1 || addedOccurrence?.atomIds.length !== 1) {
                    return false;
                }
                const deletedAtom = atomById.get(deletedOccurrence.atomIds[0]);
                const addedAtom = atomById.get(addedOccurrence.atomIds[0]);
                if (!deletedAtom || !addedAtom || deletedAtom.hunk !== addedAtom.hunk)
                    return false;
                const deletedShape = tokenShape(deletedAtom)?.key.split("\u0000")[1];
                const addedShape = tokenShape(addedAtom)?.key.split("\u0000")[1];
                return deletedShape !== undefined && deletedShape === addedShape;
            });
        });
        if (!addition)
            continue;
        consumed.add(deletion.id);
        consumed.add(addition.id);
        const signature = `${deletion.signature} -> ${addition.signature}`;
        const id = patternId(`composite\u0000${signature}`);
        const occurrences = deletion.files.map((file) => {
            const deletedOccurrence = occurrenceFor(deletion, file);
            const addedOccurrence = occurrenceFor(addition, file);
            return {
                file,
                atomIds: [...deletedOccurrence.atomIds, ...addedOccurrence.atomIds],
                bindings: { ...deletedOccurrence.bindings, ...addedOccurrence.bindings },
            };
        });
        const pattern = {
            id,
            kind: "composite",
            title: `Repeat replacement ${deletion.signature.split("\u0000")[1]} → ${addition.signature.split("\u0000")[1]}`,
            signature,
            support: deletion.support,
            files: deletion.files,
            confidence: Math.min(deletion.confidence, addition.confidence),
            occurrences,
        };
        merged.push(pattern);
        for (const atomId of occurrences.flatMap((occurrence) => occurrence.atomIds)) {
            assignments[atomId] = id;
        }
    }
    return [...patterns.filter((pattern) => !consumed.has(pattern.id)), ...merged];
}
export function validateRepeatedChangeDiscovery(discovery) {
    const { atoms, patterns, assignments, unmatchedAtomIds } = discovery;
    const diagnostics = [];
    const atomIds = new Set(atoms.map((atom) => atom.id));
    const patternIds = new Set(patterns.map((pattern) => pattern.id));
    if (atomIds.size !== atoms.length) {
        diagnostics.push({ code: "duplicate-atom", message: "Edit atom IDs must be unique." });
    }
    if (patternIds.size !== patterns.length) {
        diagnostics.push({
            code: "duplicate-pattern",
            message: "Repeated-change pattern IDs must be unique.",
        });
    }
    const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
    const occurrenceOwners = new Map();
    for (const pattern of patterns) {
        const occurrenceFiles = pattern.occurrences.map((occurrence) => occurrence.file);
        const declaredFileSet = new Set(pattern.files);
        const occurrenceFileSet = new Set(occurrenceFiles);
        if (pattern.support !== pattern.files.length ||
            pattern.support !== declaredFileSet.size ||
            pattern.support !== occurrenceFileSet.size ||
            pattern.files.some((file) => !occurrenceFileSet.has(file)) ||
            occurrenceFiles.some((file) => !declaredFileSet.has(file))) {
            diagnostics.push({
                code: "invalid-pattern-support",
                message: `Pattern '${pattern.id}' support, files, and occurrences must agree.`,
            });
        }
        for (const occurrence of pattern.occurrences) {
            for (const atomId of occurrence.atomIds) {
                const atom = atomById.get(atomId);
                if (!atom) {
                    diagnostics.push({
                        code: "unknown-occurrence-atom",
                        atomId,
                        message: `Pattern '${pattern.id}' references unknown atom '${atomId}'.`,
                    });
                    continue;
                }
                if (atom.file !== occurrence.file) {
                    diagnostics.push({
                        code: "occurrence-file-mismatch",
                        atomId,
                        message: `Atom '${atomId}' does not belong to occurrence file '${occurrence.file}'.`,
                    });
                }
                const previous = occurrenceOwners.get(atomId);
                if (previous !== undefined) {
                    diagnostics.push({
                        code: "duplicate-occurrence-ownership",
                        atomId,
                        message: `Atom '${atomId}' occurs in both '${previous}' and '${pattern.id}'.`,
                    });
                }
                else {
                    occurrenceOwners.set(atomId, pattern.id);
                }
                if (assignments[atomId] !== pattern.id) {
                    diagnostics.push({
                        code: "occurrence-assignment-mismatch",
                        atomId,
                        message: `Atom '${atomId}' occurrence and assignment disagree.`,
                    });
                }
            }
        }
    }
    for (const [atomId, assignedPattern] of Object.entries(assignments)) {
        if (!atomIds.has(atomId)) {
            diagnostics.push({
                code: "unknown-atom",
                atomId,
                message: `Assignment references unknown atom '${atomId}'.`,
            });
        }
        if (!patternIds.has(assignedPattern)) {
            diagnostics.push({
                code: "unknown-pattern",
                atomId,
                message: `Assignment references unknown pattern '${assignedPattern}'.`,
            });
        }
        if (occurrenceOwners.get(atomId) !== assignedPattern) {
            diagnostics.push({
                code: "assignment-occurrence-mismatch",
                atomId,
                message: `Assignment for '${atomId}' has no matching pattern occurrence.`,
            });
        }
    }
    const expectedUnmatched = atoms
        .map((atom) => atom.id)
        .filter((atomId) => assignments[atomId] === undefined);
    if (expectedUnmatched.length !== unmatchedAtomIds.length ||
        expectedUnmatched.some((atomId) => !unmatchedAtomIds.includes(atomId))) {
        diagnostics.push({
            code: "invalid-unmatched-inventory",
            message: "Unmatched atom IDs must equal the atoms without assignments.",
        });
    }
    return { valid: diagnostics.length === 0, diagnostics };
}
export function discoverRepeatedChanges(patch, options = {}) {
    const minimumFiles = Math.max(2, options.minimumFiles ?? 2);
    const atoms = parseEditAtoms(patch);
    const assignments = {};
    const patterns = applyRules(atoms, options.rules || [], assignments);
    if (options.automatic === false) {
        const result = {
            schemaVersion: 1,
            atoms,
            patterns,
            assignments,
            unmatchedAtomIds: atoms
                .map((atom) => atom.id)
                .filter((atomId) => assignments[atomId] === undefined),
            validation: { valid: false, diagnostics: [] },
        };
        result.validation = validateRepeatedChangeDiscovery(result);
        return result;
    }
    const bySignature = new Map();
    for (const atom of atoms) {
        if (atom.fileStatus !== "modified")
            continue;
        if (assignments[atom.id] !== undefined)
            continue;
        const signature = normalizedExact(atom);
        if (!signature)
            continue;
        const matches = bySignature.get(signature) ?? [];
        matches.push(atom);
        bySignature.set(signature, matches);
    }
    for (const [signature, candidates] of bySignature) {
        const files = [...new Set(candidates.map((atom) => atom.file))];
        const requiredFiles = lowInformationExact(signature) ? Math.max(3, minimumFiles) : minimumFiles;
        if (files.length < requiredFiles)
            continue;
        const id = patternId(`exact\u0000${signature}`);
        const occurrences = files.map((file) => ({
            file,
            atomIds: candidates.filter((atom) => atom.file === file).map((atom) => atom.id),
            bindings: {},
        }));
        patterns.push({
            id,
            kind: "exact",
            title: titleForExact(signature),
            signature,
            support: files.length,
            files,
            confidence: 1,
            occurrences,
        });
        for (const atom of candidates)
            assignments[atom.id] = id;
    }
    const byShape = new Map();
    for (const atom of atoms) {
        if (atom.fileStatus !== "modified")
            continue;
        if (assignments[atom.id] !== undefined)
            continue;
        const shape = tokenShape(atom);
        if (!shape)
            continue;
        const matches = byShape.get(shape.key) ?? [];
        matches.push(atom);
        byShape.set(shape.key, matches);
    }
    for (const shapeCandidates of byShape.values()) {
        const candidateSets = new Map();
        const addCandidateSet = (candidates) => {
            const unique = [...new Map(candidates.map((atom) => [atom.id, atom])).values()];
            const key = unique
                .map((atom) => atom.id)
                .sort()
                .join("\u0000");
            candidateSets.set(key, unique);
        };
        addCandidateSet(shapeCandidates);
        const byIdentifierAnchor = new Map();
        for (const atom of shapeCandidates) {
            for (const [index, token] of tokenizeForPattern(atom.text).entries()) {
                if (token.type !== "identifier")
                    continue;
                const key = `${index}\u0000${token.value}`;
                const anchored = byIdentifierAnchor.get(key) ?? [];
                anchored.push(atom);
                byIdentifierAnchor.set(key, anchored);
            }
        }
        for (const anchored of byIdentifierAnchor.values()) {
            if (new Set(anchored.map((atom) => atom.file)).size >= minimumFiles) {
                addCandidateSet(anchored);
            }
        }
        const ranked = [...candidateSets.values()]
            .map((candidates) => ({
            candidates,
            parameterized: parameterizedPattern(candidates),
            files: [...new Set(candidates.map((atom) => atom.file))],
        }))
            .filter((candidate) => candidate.parameterized !== null && candidate.files.length >= minimumFiles)
            .sort((left, right) => right.parameterized.specificity - left.parameterized.specificity ||
            right.files.length - left.files.length);
        for (const rankedCandidate of ranked) {
            const candidates = rankedCandidate.candidates.filter((atom) => assignments[atom.id] === undefined);
            const files = [...new Set(candidates.map((atom) => atom.file))];
            if (files.length < minimumFiles)
                continue;
            const parameterized = parameterizedPattern(candidates);
            if (!parameterized)
                continue;
            const id = patternId(`parameterized\u0000${parameterized.signature}`);
            const occurrences = files.map((file) => {
                const matchingAtoms = candidates.filter((atom) => atom.file === file);
                return {
                    file,
                    atomIds: matchingAtoms.map((atom) => atom.id),
                    bindings: Object.assign({}, ...matchingAtoms.map((atom) => parameterized.bindings.get(atom.id) || {})),
                };
            });
            patterns.push({
                id,
                kind: "parameterized",
                title: `Repeat ${parameterized.signature.replace("\u0000", " ")}`,
                signature: parameterized.signature,
                support: files.length,
                files,
                confidence: 0.94,
                occurrences,
            });
            for (const atom of candidates)
                assignments[atom.id] = id;
        }
    }
    const finalizedPatterns = mergeRepeatedReplacements(patterns, atoms, assignments);
    finalizedPatterns.sort((a, b) => b.support - a.support || a.title.localeCompare(b.title));
    const result = {
        schemaVersion: 1,
        atoms,
        patterns: finalizedPatterns,
        assignments,
        unmatchedAtomIds: atoms
            .map((atom) => atom.id)
            .filter((atomId) => assignments[atomId] === undefined),
        validation: { valid: false, diagnostics: [] },
    };
    result.validation = validateRepeatedChangeDiscovery(result);
    return result;
}
