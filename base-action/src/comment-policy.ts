import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { extname, resolve } from "path";

const MAX_SENTENCES = 2;
const MAX_COMMENT_RATIO = 0.05;

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".clj",
  ".cljs",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".hs",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".m",
  ".mm",
  ".php",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".scala",
  ".scss",
  ".scm",
  ".sh",
  ".sql",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
]);

const HASH_COMMENT_EXTENSIONS = new Set([
  ".php",
  ".py",
  ".r",
  ".rb",
  ".sh",
  ".yaml",
  ".yml",
]);
const DASH_COMMENT_EXTENSIONS = new Set([".hs", ".lua", ".sql"]);
const SEMICOLON_COMMENT_EXTENSIONS = new Set([".clj", ".cljs", ".scm"]);

type AddedLine = {
  file: string;
  line: number;
  text: string;
};

export type CommentPolicyViolation = {
  message: string;
};

type CommentBlock = {
  file: string;
  startLine: number;
  lines: string[];
};

function isSourceFile(file: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(file).toLowerCase());
}

/** Parse added lines and their final-file line numbers from a zero-context diff. */
export function parseAddedLines(diff: string): AddedLine[] {
  const result: AddedLine[] = [];
  let file = "";
  let newLine = 0;

  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("+++ b/")) {
      file = rawLine.slice(6);
      continue;
    }

    const hunk = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }

    if (!file || rawLine.startsWith("--- ")) continue;

    if (rawLine.startsWith("+")) {
      result.push({ file, line: newLine, text: rawLine.slice(1) });
      newLine += 1;
    } else if (!rawLine.startsWith("-")) {
      newLine += 1;
    }
  }

  return result;
}

function stripCommentDecoration(line: string): string {
  return line
    .trim()
    .replace(/^(?:\/\/\/?|#|--|;|%|\/\*+|\*|<!--)\s?/, "")
    .replace(/(?:\*\/|-->)\s*$/, "")
    .trim();
}

function isCommentOnlyLine(
  file: string,
  line: string,
  inBlockComment: boolean,
): boolean {
  const trimmed = line.trim();
  const extension = extname(file).toLowerCase();
  return (
    inBlockComment ||
    /^(?:\/\/|\/\*|<!--)/.test(trimmed) ||
    /^\*(?:\s|\/)/.test(trimmed) ||
    (HASH_COMMENT_EXTENSIONS.has(extension) && trimmed.startsWith("#")) ||
    (DASH_COMMENT_EXTENSIONS.has(extension) && trimmed.startsWith("--")) ||
    (SEMICOLON_COMMENT_EXTENSIONS.has(extension) && trimmed.startsWith(";")) ||
    (extension === ".m" && trimmed.startsWith("%"))
  );
}

function countSentences(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return 0;

  const boundaries = normalized.match(/[.!?](?:["')\]]*)?(?=\s|$)/g);
  return boundaries?.length ?? 1;
}

/** Check added source lines against the Action's code-comment limits. */
export function checkCommentPolicy(
  addedLines: AddedLine[],
): CommentPolicyViolation[] {
  const sourceLines = addedLines.filter((line) => isSourceFile(line.file));
  const nonBlankLines = sourceLines.filter((line) => line.text.trim()).length;
  const commentLines: AddedLine[] = [];
  const blocks: CommentBlock[] = [];
  let current: CommentBlock | undefined;
  let previousLine = -2;
  let previousFile = "";
  let inBlockComment = false;

  for (const line of sourceLines) {
    if (line.file !== previousFile || line.line !== previousLine + 1) {
      current = undefined;
      inBlockComment = false;
    }

    const commentOnly = isCommentOnlyLine(line.file, line.text, inBlockComment);
    const trimmed = line.text.trim();

    if (commentOnly) {
      commentLines.push(line);
      if (!current) {
        current = { file: line.file, startLine: line.line, lines: [] };
        blocks.push(current);
      }
      current.lines.push(stripCommentDecoration(line.text));
    } else if (trimmed) {
      current = undefined;
    }

    if (trimmed.includes("/*") && !trimmed.includes("*/")) {
      inBlockComment = true;
    }
    if (inBlockComment && trimmed.includes("*/")) {
      inBlockComment = false;
      current = undefined;
    }

    previousFile = line.file;
    previousLine = line.line;
  }

  const violations: CommentPolicyViolation[] = [];
  for (const block of blocks) {
    const sentences = countSentences(block.lines.join(" "));
    if (sentences > MAX_SENTENCES) {
      violations.push({
        message: `${block.file}:${block.startLine} has ${sentences} sentences; comments may have at most ${MAX_SENTENCES}.`,
      });
    }
  }

  const ratio = nonBlankLines === 0 ? 0 : commentLines.length / nonBlankLines;
  if (ratio > MAX_COMMENT_RATIO) {
    violations.push({
      message: `Added source lines are ${(ratio * 100).toFixed(1)}% comments (${commentLines.length}/${nonBlankLines}); the maximum is 5%.`,
    });
  }

  return violations;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function findBaseRef(cwd: string): string | undefined {
  const candidates = [
    process.env.CLAUDE_BASE_BRANCH
      ? `origin/${process.env.CLAUDE_BASE_BRANCH}`
      : undefined,
    process.env.CLAUDE_BASE_BRANCH,
    process.env.CLAUDE_INITIAL_HEAD,
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => {
    try {
      git(["rev-parse", "--verify", candidate], cwd);
      return true;
    } catch {
      return false;
    }
  });
}

export function runCommentPolicyCheck(cwd: string): CommentPolicyViolation[] {
  const baseRef = findBaseRef(cwd);
  if (!baseRef) return [];

  const mergeBase = git(["merge-base", baseRef, "HEAD"], cwd).trim();
  const diff = git(["diff", "--unified=0", "--no-color", mergeBase, "--"], cwd);
  const addedLines = parseAddedLines(diff);

  const untracked = git(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    cwd,
  )
    .split("\0")
    .filter(Boolean);
  for (const file of untracked) {
    if (!isSourceFile(file)) continue;
    const path = resolve(cwd, file);
    if (!existsSync(path)) continue;
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((text, index) => {
        addedLines.push({ file, line: index + 1, text });
      });
  }

  return checkCommentPolicy(addedLines);
}

if (import.meta.main) {
  try {
    const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
    const violations = runCommentPolicyCheck(cwd);
    if (violations.length > 0) {
      const details = violations
        .map(({ message }) => `- ${message}`)
        .join("\n");
      console.log(
        JSON.stringify({
          decision: "block",
          reason: `Code comment policy failed. Remove or shorten comments before finishing:\n\n${details}`,
        }),
      );
    }
  } catch (error) {
    console.error(`Comment policy check failed to run: ${String(error)}`);
    process.exitCode = 1;
  }
}
