import path from "node:path";
const TYPE_BY_EXTENSION = {
    ".c": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".cxx": "cpp",
    ".h": "cpp",
    ".hh": "cpp",
    ".hpp": "cpp",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "typescript",
    ".json": "json",
    ".jsonc": "json",
    ".json5": "json",
    ".md": "markdown",
    ".mdx": "markdown",
    ".markdown": "markdown",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".graphql": "graphql",
    ".gql": "graphql",
    ".m": "objectivec",
    ".mm": "objectivec",
    ".vb": "vbnet",
    ".vbs": "vbnet",
    ".wat": "wasm",
    ".wasm": "wasm",
    ".diff": "diff",
    ".patch": "diff",
    ".html": "xml",
    ".htm": "xml",
    ".xml": "xml",
    ".svg": "xml",
    ".vue": "xml",
    ".svelte": "xml",
    ".astro": "xml",
    ".ini": "ini",
    ".cfg": "ini",
    ".conf": "ini",
    ".properties": "ini",
};
const GENERATED_PATHS = [
    /(^|\/)(dist|build|coverage|vendor|generated|gen)(\/|$)/i,
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|composer\.lock)$/i,
    /\.(min\.(js|css)|generated\.[^.]+)$/i,
];
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
export function decodeGitPath(token) {
    if (!token.startsWith('"') || !token.endsWith('"'))
        return token;
    const input = token.slice(1, -1);
    const bytes = [];
    const escapes = {
        a: 0x07,
        b: 0x08,
        t: 0x09,
        n: 0x0a,
        v: 0x0b,
        f: 0x0c,
        r: 0x0d,
    };
    for (let index = 0; index < input.length; index++) {
        if (input[index] !== "\\") {
            const codePoint = input.codePointAt(index);
            if (codePoint === undefined)
                break;
            bytes.push(...textEncoder.encode(String.fromCodePoint(codePoint)));
            if (codePoint > 0xffff)
                index++;
            continue;
        }
        index++;
        const octal = /^[0-7]{1,3}/.exec(input.slice(index));
        if (octal) {
            bytes.push(Number.parseInt(octal[0], 8));
            index += octal[0].length - 1;
        }
        else {
            const escaped = input[index] ?? "";
            const escapedByte = escapes[escaped];
            if (escapedByte !== undefined)
                bytes.push(escapedByte);
            else
                bytes.push(...textEncoder.encode(escaped));
        }
    }
    return textDecoder.decode(Uint8Array.from(bytes));
}
export function parseDiffPaths(line) {
    const unquoted = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (unquoted)
        return { oldPath: unquoted[1], path: unquoted[2] };
    const quoted = /^diff --git ("(?:\\.|[^"])*") ("(?:\\.|[^"])*")$/.exec(line);
    if (!quoted)
        return null;
    const oldPath = decodeGitPath(quoted[1]).replace(/^a\//, "");
    const newPath = decodeGitPath(quoted[2]).replace(/^b\//, "");
    return { oldPath, path: newPath };
}
function parseMarkerPath(line, marker) {
    if (!line.startsWith(marker))
        return null;
    const decoded = decodeGitPath(line.slice(marker.length));
    if (decoded === "/dev/null")
        return decoded;
    return decoded.replace(/^[ab]\//, "");
}
function fileType(file) {
    const basename = path.posix.basename(file).toLowerCase();
    if (basename === "cmakelists.txt" || basename.endsWith(".cmake"))
        return "cmake";
    if (basename === "makefile")
        return "makefile";
    return TYPE_BY_EXTENSION[path.posix.extname(basename)] || "other";
}
function isGenerated(file, addedLines) {
    if (GENERATED_PATHS.some((pattern) => pattern.test(file)))
        return true;
    return addedLines
        .slice(0, 5)
        .some((line) => /(@generated|generated (file|code)|do not edit|automatically generated)/i.test(line));
}
function finishFile(file) {
    if (!file)
        return null;
    file.type = fileType(file.path);
    file.generated = isGenerated(file.path, file._addedLines);
    const { _addedLines: _, ...finished } = file;
    return finished;
}
export function analyzePatch(text) {
    const normalized = String(text).replace(/\r\n?/g, "\n");
    const files = [];
    const whitespaceErrors = [];
    const diagnostics = [];
    let current = null;
    let newLine = 0;
    const pushCurrent = () => {
        const finished = finishFile(current);
        if (finished)
            files.push(finished);
        current = null;
    };
    for (const line of normalized.split("\n")) {
        let match;
        const diffPaths = parseDiffPaths(line);
        if (diffPaths) {
            pushCurrent();
            current = {
                path: diffPaths.path,
                oldPath: diffPaths.oldPath,
                additions: 0,
                deletions: 0,
                binary: false,
                generated: false,
                type: "other",
                _addedLines: [],
            };
            continue;
        }
        if (!current)
            continue;
        if (/^(GIT binary patch|Binary files? )/.test(line)) {
            current.binary = true;
            continue;
        }
        const newMarkerPath = parseMarkerPath(line, "+++ ");
        if (newMarkerPath && newMarkerPath !== "/dev/null") {
            current.path = newMarkerPath;
            continue;
        }
        if ((match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line))) {
            newLine = Number(match[1]);
            continue;
        }
        if (line.startsWith("+") && !line.startsWith("+++")) {
            const content = line.slice(1);
            current.additions++;
            current._addedLines.push(content);
            if (/[ \t]+$/.test(content)) {
                whitespaceErrors.push({
                    file: current.path,
                    line: newLine,
                    kind: "trailing-whitespace",
                });
            }
            newLine++;
        }
        else if (line.startsWith("-") && !line.startsWith("---")) {
            current.deletions++;
        }
        else if (line.startsWith(" ")) {
            newLine++;
        }
    }
    pushCurrent();
    if (normalized.trim() && files.length === 0) {
        diagnostics.push({
            level: "error",
            code: "invalid-patch",
            message: "No Git 'diff --git' file headers were found.",
        });
    }
    for (const file of files) {
        if (!file.binary &&
            file.additions === 0 &&
            file.deletions === 0 &&
            file.oldPath === file.path) {
            diagnostics.push({
                level: "warning",
                code: "empty-file-diff",
                file: file.path,
                message: "The file has no hunks, binary marker, or rename.",
            });
        }
    }
    return {
        schemaVersion: 1,
        totals: {
            files: files.length,
            additions: files.reduce((sum, file) => sum + file.additions, 0),
            deletions: files.reduce((sum, file) => sum + file.deletions, 0),
            bytes: Buffer.byteLength(text),
        },
        patch: {
            valid: !diagnostics.some((item) => item.level === "error"),
            diagnostics,
        },
        files,
        whitespaceErrors,
    };
}
export function preflightPatch(text, run, cwd) {
    const normalized = String(text).replace(/\r\n?/g, "\n");
    const result = analyzePatch(normalized);
    try {
        const numstat = run("git", ["apply", "--numstat", "-"], { cwd, input: normalized });
        result.patch.gitApply = {
            valid: true,
            numstat: String(numstat || "").trim(),
        };
    }
    catch (error) {
        result.patch.valid = false;
        result.patch.gitApply = { valid: false, numstat: "" };
        result.patch.diagnostics.push({
            level: "error",
            code: "git-apply-check-failed",
            message: error instanceof Error ? error.message : "Git rejected the patch.",
        });
    }
    return result;
}
