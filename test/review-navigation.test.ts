import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  filterNavigationItems,
  findingsWithinNavigationLines,
  firstNavigationLineMatch,
  type NavigationItem,
} from "../src/review-navigation.js";

const items: NavigationItem[] = [
  {
    id: "auth",
    path: "src/auth.ts",
    content: "export function restoreSession() {}",
    lines: [{ key: "12", text: "export function restoreSession() {}" }],
    findingText: "The expired session remains active.",
    findings: [{ key: "12", text: "The expired session remains active." }],
    viewed: false,
    hasOpenFinding: true,
    severities: ["concern"],
    test: false,
    generated: false,
    risks: ["high"],
    groups: ["Session lifecycle"],
  },
  {
    id: "test",
    path: "test/auth.test.ts",
    content: "test('rejects expired tokens', () => {})",
    lines: [{ key: "8", text: "test('rejects expired tokens', () => {})" }],
    findingText: "",
    findings: [],
    viewed: true,
    hasOpenFinding: false,
    severities: [],
    test: true,
    generated: false,
    risks: ["low"],
    groups: ["Associated tests"],
  },
  {
    id: "generated",
    path: "generated/api.generated.ts",
    content: "export const apiVersion = 2;",
    lines: [{ key: "1", text: "export const apiVersion = 2;" }],
    findingText: "Regenerate this file from the schema.",
    findings: [{ key: "1", text: "Regenerate this file from the schema." }],
    viewed: false,
    hasOpenFinding: true,
    severities: ["suggestion"],
    test: false,
    generated: true,
    risks: ["medium"],
    groups: ["Generated clients"],
  },
];

test("navigation search matches paths, diff content, and findings", () => {
  assert.deepEqual(
    filterNavigationItems(items, { text: "auth.test" }).map((item) => item.id),
    ["test"],
  );
  assert.deepEqual(
    filterNavigationItems(items, { text: "restoreSession" }).map((item) => item.id),
    ["auth"],
  );
  assert.deepEqual(
    filterNavigationItems(items, { text: "expired session" }).map((item) => item.id),
    ["auth"],
  );
});

test("navigation identifies the first matching diff line", () => {
  assert.equal(firstNavigationLineMatch(items[0], "restoreSession"), "12");
  assert.equal(firstNavigationLineMatch(items[0], "expired session"), "12");
  assert.equal(
    firstNavigationLineMatch(
      {
        ...items[0],
        content: "restoreSession\nexpired token",
        lines: [
          { key: "12", text: "restoreSession" },
          { key: "13", text: "expired token" },
        ],
      },
      "restoreSession expired",
    ),
    "12",
  );
});

test("grouped occurrences retain only findings anchored to their lines", () => {
  const findings = [
    { key: "12", text: "First group finding" },
    { key: "48", text: "Second group finding" },
  ];

  assert.deepEqual(findingsWithinNavigationLines([{ key: "12" }], findings), [findings[0]]);
  assert.deepEqual(findingsWithinNavigationLines([{ key: "48" }], findings), [findings[1]]);
});

test("navigation filters combine unread, findings, classification, severity, risk, and group", () => {
  assert.deepEqual(
    filterNavigationItems(items, {
      unread: true,
      openFindings: true,
      severity: "concern",
      risk: "high",
      group: "Session lifecycle",
    }).map((item) => item.id),
    ["auth"],
  );
  assert.deepEqual(
    filterNavigationItems(items, { tests: true }).map((item) => item.id),
    ["test"],
  );
  assert.deepEqual(
    filterNavigationItems(items, { generated: true }).map((item) => item.id),
    ["generated"],
  );
});

test("navigation filtering stays responsive for a 300-file review", () => {
  const largeReview: NavigationItem[] = Array.from({ length: 300 }, (_, index) => {
    const lines = Array.from({ length: 120 }, (__, line) => ({
      key: String(line + 1),
      text: `const value_${index}_${line} = ${line};`,
    }));
    return {
      id: String(index),
      path: `src/module-${index}.ts`,
      content: lines.map((line) => line.text).join("\n"),
      lines,
      findingText: index === 299 ? "The final sentinel finding." : "",
      findings: index === 299 ? [{ key: "300", text: "The final sentinel finding." }] : [],
      viewed: index % 2 === 0,
      hasOpenFinding: index === 299,
      severities: index === 299 ? ["concern"] : [],
      test: false,
      generated: false,
      risks: [index === 299 ? "high" : "low"],
      groups: [index === 299 ? "Sentinel" : "Modules"],
    };
  });

  const started = performance.now();
  const result = filterNavigationItems(largeReview, {
    text: "final sentinel",
    unread: true,
    openFindings: true,
    severity: "concern",
    risk: "high",
    group: "Sentinel",
  });
  const duration = performance.now() - started;

  assert.deepEqual(
    result.map((item) => item.id),
    ["299"],
  );
  assert.ok(duration < 250, `expected filtering under 250ms, received ${duration.toFixed(1)}ms`);
});
