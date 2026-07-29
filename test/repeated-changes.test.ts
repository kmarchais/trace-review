import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  discoverRepeatedChanges,
  parseDetectorRuleSet,
  validateRepeatedChangeDiscovery,
  type DetectorRule,
} from "../scripts/lib/repeated-changes.mjs";

test("discovers an exact changed line repeated across files", () => {
  const patch = `diff --git a/src/a.cpp b/src/a.cpp
index 1111111..2222222 100644
--- a/src/a.cpp
+++ b/src/a.cpp
@@ -1 +1,2 @@
 int a;
+enableNewCache();
diff --git a/src/b.cpp b/src/b.cpp
index 1111111..2222222 100644
--- a/src/b.cpp
+++ b/src/b.cpp
@@ -1 +1,2 @@
 int b;
+enableNewCache();
diff --git a/src/c.cpp b/src/c.cpp
index 1111111..2222222 100644
--- a/src/c.cpp
+++ b/src/c.cpp
@@ -1 +1,2 @@
 int c;
+enableNewCache();
`;

  const discovery = discoverRepeatedChanges(patch);

  assert.equal(discovery.validation.valid, true);
  assert.equal(discovery.patterns.length, 1);
  assert.equal(discovery.patterns[0].kind, "exact");
  assert.equal(discovery.patterns[0].support, 3);
  assert.deepEqual(discovery.patterns[0].files, ["src/a.cpp", "src/b.cpp", "src/c.cpp"]);
  assert.match(discovery.patterns[0].title, /enableNewCache/);
  assert.equal(discovery.patterns[0].occurrences.flatMap((item) => item.atomIds).length, 3);
});

test("does not extract repeated lines from newly added files by default", () => {
  const patch = ["a", "b", "c"]
    .map(
      (name) => `diff --git a/include/${name}.h b/include/${name}.h
new file mode 100644
--- /dev/null
+++ b/include/${name}.h
@@ -0,0 +1,2 @@
+#pragma once
+struct ${name.toUpperCase()} {};
`,
    )
    .join("");

  const discovery = discoverRepeatedChanges(patch);

  assert.equal(discovery.patterns.length, 0);
});

test("discovers punctuation-only exact lines when they repeat broadly", () => {
  const patch = ["a", "b", "c"]
    .map(
      (name) => `diff --git a/src/${name}.cpp b/src/${name}.cpp
--- a/src/${name}.cpp
+++ b/src/${name}.cpp
@@ -1 +1,2 @@
 int ${name};
+});
`,
    )
    .join("");

  const discovery = discoverRepeatedChanges(patch);

  assert.equal(discovery.patterns.length, 1);
  assert.equal(discovery.patterns[0].kind, "exact");
  assert.equal(discovery.patterns[0].support, 3);
});

test("rejects malformed adaptive detector rule sets before execution", () => {
  assert.throws(
    () =>
      parseDetectorRuleSet({
        schemaVersion: 1,
        rules: [
          {
            id: "unsafe rule",
            title: "Invalid",
            operations: [{ side: "run", pattern: "anything" }],
          },
        ],
      }),
    /id must use/,
  );
  assert.throws(
    () =>
      parseDetectorRuleSet({
        schemaVersion: 1,
        rules: [
          {
            id: "single-file",
            title: "Single file",
            minimumFiles: 1,
            operations: [{ side: "add", pattern: "anything" }],
          },
        ],
      }),
    /minimumFiles must be an integer from 2/,
  );
});

test("audits occurrence ownership against deterministic assignments", () => {
  const patch = ["a", "b"]
    .map(
      (name) => `diff --git a/src/${name}.cpp b/src/${name}.cpp
--- a/src/${name}.cpp
+++ b/src/${name}.cpp
@@ -1 +1,2 @@
 int ${name};
+enableNewCache();
`,
    )
    .join("");
  const discovery = discoverRepeatedChanges(patch);
  const assignments = { ...discovery.assignments };
  delete assignments[discovery.patterns[0].occurrences[0].atomIds[0]];

  const validation = validateRepeatedChangeDiscovery({ ...discovery, assignments });

  assert.equal(validation.valid, false);
  assert.ok(
    validation.diagnostics.some(
      (diagnostic) => diagnostic.code === "occurrence-assignment-mismatch",
    ),
  );
});

test("rejects duplicate declared files in a pattern inventory", () => {
  const patch = ["a", "b"]
    .map(
      (name) => `diff --git a/src/${name}.cpp b/src/${name}.cpp
--- a/src/${name}.cpp
+++ b/src/${name}.cpp
@@ -1 +1,2 @@
 int ${name};
+enableNewCache();
`,
    )
    .join("");
  const discovery = discoverRepeatedChanges(patch);
  const malformedPattern = {
    ...discovery.patterns[0],
    files: [discovery.patterns[0].files[0], discovery.patterns[0].files[0]],
  };

  const validation = validateRepeatedChangeDiscovery({
    ...discovery,
    patterns: [malformedPattern],
  });

  assert.equal(validation.valid, false);
  assert.ok(
    validation.diagnostics.some((diagnostic) => diagnostic.code === "invalid-pattern-support"),
  );
});

test("discovers a parameterized line when identifiers vary by file", () => {
  const patch = `diff --git a/src/user.cpp b/src/user.cpp
--- a/src/user.cpp
+++ b/src/user.cpp
@@ -1 +1,2 @@
 void loadUser();
+cache.insert(userId, user);
diff --git a/src/order.cpp b/src/order.cpp
--- a/src/order.cpp
+++ b/src/order.cpp
@@ -1 +1,2 @@
 void loadOrder();
+cache.insert(orderId, order);
diff --git a/src/team.cpp b/src/team.cpp
--- a/src/team.cpp
+++ b/src/team.cpp
@@ -1 +1,2 @@
 void loadTeam();
+cache.insert(teamId, team);
`;

  const discovery = discoverRepeatedChanges(patch);

  assert.equal(discovery.patterns.length, 1);
  assert.equal(discovery.patterns[0].kind, "parameterized");
  assert.equal(discovery.patterns[0].support, 3);
  assert.match(discovery.patterns[0].signature, /\$identifier/);
  assert.deepEqual(
    discovery.patterns[0].occurrences.map((item) => Object.values(item.bindings)),
    [
      ["userId", "user"],
      ["orderId", "order"],
      ["teamId", "team"],
    ],
  );
});

test("separates repeated families that share the same coarse token shape", () => {
  const additions = [
    ["a", "cache.insert(userId, user);"],
    ["b", "cache.insert(teamId, team);"],
    ["c", "audit.record(orderId, order);"],
    ["d", "audit.record(invoiceId, invoice);"],
  ];
  const patch = additions
    .map(
      ([name, line]) => `diff --git a/src/${name}.cpp b/src/${name}.cpp
--- a/src/${name}.cpp
+++ b/src/${name}.cpp
@@ -1 +1,2 @@
 int value;
+${line}
`,
    )
    .join("");

  const discovery = discoverRepeatedChanges(patch);

  assert.equal(discovery.patterns.length, 2);
  assert.deepEqual(
    discovery.patterns.map((pattern) => pattern.files),
    [
      ["src/c.cpp", "src/d.cpp"],
      ["src/a.cpp", "src/b.cpp"],
    ],
  );
});

test("combines compatible repeated deletions and additions into replacements", () => {
  const patch = ["velocity", "radius", "duration"]
    .map(
      (name) => `diff --git a/include/${name}.h b/include/${name}.h
--- a/include/${name}.h
+++ b/include/${name}.h
@@ -1 +1 @@
-float ${name};
+Scalar ${name};
`,
    )
    .join("");

  const discovery = discoverRepeatedChanges(patch);

  assert.equal(discovery.patterns.length, 1);
  assert.equal(discovery.patterns[0].kind, "composite");
  assert.equal(discovery.patterns[0].support, 3);
  assert.ok(discovery.patterns[0].occurrences.every((item) => item.atomIds.length === 2));
  assert.equal(Object.keys(discovery.assignments).length, 6);
});

test("evaluates an adaptive rule across hunks while leaving unrelated rows unmatched", () => {
  const filePatch = (
    name: string,
    guard: string,
    value: number,
  ): string => `diff --git a/${name} b/${name}
--- a/${name}
+++ b/${name}
@@ -1,5 +1,4 @@
-#ifndef ${guard}
-#define ${guard}
+#pragma once
 ${""}
-float value = ${value}.0f;
+Scalar value = ${value}.0;
@@ -20,2 +19 @@
-#endif // ${guard}
 int tail;
`;
  const patch =
    filePatch("include/a.h", "INCLUDE_A_H", 1) +
    filePatch("include/b.h", "INCLUDE_B_H", 2) +
    filePatch("include/c.h", "INCLUDE_C_H", 3);
  const rule: DetectorRule = {
    id: "header-guard-migration",
    title: "Replace header guards with pragma once",
    minimumFiles: 3,
    operations: [
      { side: "add", pattern: "# pragma once", location: "start" },
      { side: "delete", pattern: "# ifndef $guard", location: "start" },
      { side: "delete", pattern: "# define $guard", location: "start" },
      { side: "delete", pattern: "# endif // $guard", location: "end" },
    ],
  };

  const discovery = discoverRepeatedChanges(patch, { rules: [rule], automatic: false });

  assert.equal(discovery.patterns[0].kind, "rule");
  assert.equal(discovery.patterns[0].support, 3);
  assert.ok(discovery.patterns[0].occurrences.every((item) => item.atomIds.length === 4));
  assert.deepEqual(
    discovery.patterns[0].occurrences.map((item) => item.bindings.guard),
    ["INCLUDE_A_H", "INCLUDE_B_H", "INCLUDE_C_H"],
  );
  assert.equal(discovery.unmatchedAtomIds.length, 6);
});

test("indexes repeated changes without an all-pairs performance cliff", () => {
  const patch = Array.from(
    { length: 1_000 },
    (_, index) => `diff --git a/src/file-${index}.cpp b/src/file-${index}.cpp
--- a/src/file-${index}.cpp
+++ b/src/file-${index}.cpp
@@ -1 +1,3 @@
 int value = ${index};
+enableNewCache();
+cache.insert(item${index}, value${index});
`,
  ).join("");

  const started = performance.now();
  const discovery = discoverRepeatedChanges(patch);
  const duration = performance.now() - started;

  assert.equal(discovery.patterns[0].support, 1_000);
  assert.ok(duration < 1_000, `repeated-change discovery took ${duration.toFixed(0)}ms`);
});
