#!/usr/bin/env bun

import { describe, expect, test } from "bun:test";
import { checkCommentPolicy, parseAddedLines } from "../src/comment-policy";

function addedSourceLines(comment: string, codeLineCount: number) {
  return parseAddedLines(
    [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      `@@ -0,0 +1,${codeLineCount + 1} @@`,
      `+${comment}`,
      ...Array.from(
        { length: codeLineCount },
        (_, index) => `+const value${index} = ${index};`,
      ),
    ].join("\n"),
  );
}

describe("code comment policy", () => {
  test("parses added lines with final-file line numbers", () => {
    const lines = parseAddedLines(
      [
        "diff --git a/example.ts b/example.ts",
        "--- a/example.ts",
        "+++ b/example.ts",
        "@@ -4,0 +5,2 @@",
        "+// explanation",
        "+const answer = 42;",
      ].join("\n"),
    );

    expect(lines).toEqual([
      { file: "example.ts", line: 5, text: "// explanation" },
      { file: "example.ts", line: 6, text: "const answer = 42;" },
    ]);
  });

  test("allows a two-sentence comment at exactly five percent", () => {
    const violations = checkCommentPolicy(
      addedSourceLines("// First sentence. Second sentence.", 19),
    );

    expect(violations).toEqual([]);
  });

  test("blocks a comment longer than two sentences", () => {
    const violations = checkCommentPolicy(
      addedSourceLines("// First. Second. Third.", 30),
    );

    expect(
      violations.some(({ message }) => message.includes("3 sentences")),
    ).toBe(true);
  });

  test("counts sentences across a multiline comment block", () => {
    const lines = parseAddedLines(
      [
        "diff --git a/example.ts b/example.ts",
        "--- a/example.ts",
        "+++ b/example.ts",
        "@@ -0,0 +1,23 @@",
        "+/* First sentence.",
        "+ * Second sentence.",
        "+ * Third sentence. */",
        ...Array.from(
          { length: 20 },
          (_, index) => `+const value${index} = ${index};`,
        ),
      ].join("\n"),
    );

    expect(
      checkCommentPolicy(lines).some(({ message }) =>
        message.includes("3 sentences"),
      ),
    ).toBe(true);
  });

  test("rejects an issue narrative prepended to a new test file", () => {
    const lines = parseAddedLines(
      [
        "diff --git a/src/example.issue8955.test.ts b/src/example.issue8955.test.ts",
        "--- /dev/null",
        "+++ b/src/example.issue8955.test.ts",
        "@@ -0,0 +1,108 @@",
        "+/**",
        "+ * Regression tests for issue #8955. This restates the reported bug.",
        "+ * It then narrates the internal state that caused it.",
        "+ *",
        "+ * The next paragraphs document the implementation in excessive detail.",
        ...Array.from({ length: 20 }, () => "+ * More narrative text"),
        "+ */",
        ...Array.from(
          { length: 82 },
          (_, index) => `+const value${index} = ${index};`,
        ),
      ].join("\n"),
    );

    const violations = checkCommentPolicy(lines);
    expect(
      violations.some(({ message }) => message.includes("24.1% comments")),
    ).toBe(true);
    expect(
      violations.some(({ message }) => message.includes("4 sentences")),
    ).toBe(true);
  });

  test("blocks comments above five percent of added source lines", () => {
    const violations = checkCommentPolicy(
      addedSourceLines("// Concise explanation.", 18),
    );

    expect(
      violations.some(({ message }) =>
        message.includes("5.3% comments (1/19)"),
      ),
    ).toBe(true);
  });

  test("ignores non-source files", () => {
    const lines = parseAddedLines(
      [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -0,0 +1,1 @@",
        "+# This is documentation. It can contain many sentences. That is fine.",
      ].join("\n"),
    );

    expect(checkCommentPolicy(lines)).toEqual([]);
  });

  test("does not mistake C preprocessor directives for comments", () => {
    const lines = parseAddedLines(
      [
        "diff --git a/example.c b/example.c",
        "--- a/example.c",
        "+++ b/example.c",
        "@@ -0,0 +1,1 @@",
        "+#include <stdio.h>",
      ].join("\n"),
    );

    expect(checkCommentPolicy(lines)).toEqual([]);
  });

  test("does not treat comment delimiters inside strings as comments", () => {
    const lines = parseAddedLines(
      [
        "diff --git a/example.ts b/example.ts",
        "--- a/example.ts",
        "+++ b/example.ts",
        "@@ -0,0 +1,3 @@",
        '+const opener = "/**";',
        '+const text = "This is code, not a comment.";',
        '+const closer = "*/";',
      ].join("\n"),
    );

    expect(checkCommentPolicy(lines)).toEqual([]);
  });
});
