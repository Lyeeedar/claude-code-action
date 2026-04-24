import type {
  GitHubPullRequest,
  GitHubIssue,
  GitHubComment,
  GitHubFile,
  GitHubReview,
  LinkedIssue,
  LinkedPullRequest,
} from "../types";
import type { GitHubFileWithSHA } from "./fetcher";
import { sanitizeContent } from "../utils/sanitizer";

export function formatContext(
  contextData: GitHubPullRequest | GitHubIssue,
  isPR: boolean,
): string {
  if (isPR) {
    const prData = contextData as GitHubPullRequest;
    const sanitizedTitle = sanitizeContent(prData.title);
    return `PR Title: ${sanitizedTitle}
PR Author: ${prData.author.login}
PR Branch: ${prData.headRefName} -> ${prData.baseRefName}
PR State: ${prData.state}
PR Additions: ${prData.additions}
PR Deletions: ${prData.deletions}
Total Commits: ${prData.commits.totalCount}
Changed Files: ${prData.files.nodes.length} files`;
  } else {
    const issueData = contextData as GitHubIssue;
    const sanitizedTitle = sanitizeContent(issueData.title);
    return `Issue Title: ${sanitizedTitle}
Issue Author: ${issueData.author.login}
Issue State: ${issueData.state}`;
  }
}

export function formatBody(
  body: string,
  imageUrlMap: Map<string, string>,
): string {
  let processedBody = body;

  for (const [originalUrl, localPath] of imageUrlMap) {
    processedBody = processedBody.replaceAll(originalUrl, localPath);
  }

  processedBody = sanitizeContent(processedBody);

  return processedBody;
}

export function formatComments(
  comments: GitHubComment[],
  imageUrlMap?: Map<string, string>,
): string {
  return comments
    .filter((comment) => !comment.isMinimized)
    .map((comment) => {
      let body = comment.body;

      if (imageUrlMap && body) {
        for (const [originalUrl, localPath] of imageUrlMap) {
          body = body.replaceAll(originalUrl, localPath);
        }
      }

      body = sanitizeContent(body);

      return `[${comment.author.login} at ${comment.createdAt}]: ${body}`;
    })
    .join("\n\n");
}

export function formatReviewComments(
  reviewData: { nodes: GitHubReview[] } | null,
  imageUrlMap?: Map<string, string>,
): string {
  if (!reviewData || !reviewData.nodes) {
    return "";
  }

  const formattedReviews = reviewData.nodes.map((review) => {
    let reviewOutput = `[Review by ${review.author.login} at ${review.submittedAt}]: ${review.state}`;

    if (review.body && review.body.trim()) {
      let body = review.body;

      if (imageUrlMap) {
        for (const [originalUrl, localPath] of imageUrlMap) {
          body = body.replaceAll(originalUrl, localPath);
        }
      }

      const sanitizedBody = sanitizeContent(body);
      reviewOutput += `\n${sanitizedBody}`;
    }

    if (
      review.comments &&
      review.comments.nodes &&
      review.comments.nodes.length > 0
    ) {
      const comments = review.comments.nodes
        .filter((comment) => !comment.isMinimized)
        .map((comment) => {
          let body = comment.body;

          if (imageUrlMap) {
            for (const [originalUrl, localPath] of imageUrlMap) {
              body = body.replaceAll(originalUrl, localPath);
            }
          }

          body = sanitizeContent(body);

          return `  [Comment on ${comment.path}:${comment.line || "?"}]: ${body}`;
        })
        .join("\n");
      if (comments) {
        reviewOutput += `\n${comments}`;
      }
    }

    return reviewOutput;
  });

  return formattedReviews.join("\n\n");
}

export function formatChangedFiles(changedFiles: GitHubFile[]): string {
  return changedFiles
    .map(
      (file) =>
        `- ${file.path} (${file.changeType}) +${file.additions}/-${file.deletions}`,
    )
    .join("\n");
}

export function formatLinkedIssues(
  issues: LinkedIssue[],
  imageUrlMap?: Map<string, string>,
): string {
  if (issues.length === 0) return "";
  return issues
    .map((issue) => {
      const body = formatBody(issue.body || "", imageUrlMap ?? new Map());
      const comments = formatComments(issue.comments.nodes, imageUrlMap);
      let out = `### Linked Issue #${issue.number}: ${sanitizeContent(issue.title)}
Author: ${issue.author.login} | State: ${issue.state}

${body}`;
      if (comments) out += `\n\n**Comments:**\n${comments}`;
      return out;
    })
    .join("\n\n---\n\n");
}

export function formatLinkedPullRequests(
  prs: LinkedPullRequest[],
  imageUrlMap?: Map<string, string>,
): string {
  if (prs.length === 0) return "";
  return prs
    .map((pr) => {
      const body = formatBody(pr.body || "", imageUrlMap ?? new Map());
      const comments = formatComments(pr.comments.nodes, imageUrlMap);
      let out = `### Linked PR #${pr.number}: ${sanitizeContent(pr.title)}
Author: ${pr.author.login} | State: ${pr.state} | Branch: ${pr.headRefName} -> ${pr.baseRefName}

${body}`;
      if (comments) out += `\n\n**Comments:**\n${comments}`;
      return out;
    })
    .join("\n\n---\n\n");
}

export function formatChangedFilesWithSHA(
  changedFiles: GitHubFileWithSHA[],
): string {
  return changedFiles
    .map(
      (file) =>
        `- ${file.path} (${file.changeType}) +${file.additions}/-${file.deletions} SHA: ${file.sha}`,
    )
    .join("\n");
}
