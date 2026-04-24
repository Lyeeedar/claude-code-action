import type { Octokits } from "../api/client";
import { GITHUB_SERVER_URL } from "../api/config";
import { $ } from "bun";

export async function checkAndCommitOrDeleteBranch(
  octokit: Octokits,
  owner: string,
  repo: string,
  claudeBranch: string | undefined,
  baseBranch: string,
  useCommitSigning: boolean,
): Promise<{ shouldDeleteBranch: boolean; branchLink: string }> {
  let branchLink = "";
  let shouldDeleteBranch = false;

  if (claudeBranch) {
    // First check if the branch exists remotely
    let branchExistsRemotely = false;
    try {
      await octokit.rest.repos.getBranch({
        owner,
        repo,
        branch: claudeBranch,
      });
      branchExistsRemotely = true;
    } catch (error: any) {
      if (error.status === 404) {
        console.log(`Branch ${claudeBranch} does not exist remotely`);
      } else {
        console.error("Error checking if branch exists:", error);
      }
    }

    // If branch doesn't exist remotely, try pushing it — Claude may have
    // committed locally but the final push failed (e.g. transient 500 error).
    if (!branchExistsRemotely) {
      console.log(`Branch ${claudeBranch} not on remote, attempting to push...`);
      let pushed = false;
      for (let attempt = 1; attempt <= 3 && !pushed; attempt++) {
        try {
          await $`git push -u origin ${claudeBranch}`;
          pushed = true;
          branchExistsRemotely = true;
          console.log(`✅ Successfully pushed branch ${claudeBranch}`);
        } catch (pushError) {
          if (attempt < 3) {
            console.log(`Push attempt ${attempt} failed, retrying in 3s...`);
            await new Promise((r) => setTimeout(r, 3000));
          } else {
            console.error(`Failed to push branch after 3 attempts:`, pushError);
          }
        }
      }
      if (!pushed) {
        return { shouldDeleteBranch: false, branchLink: "" };
      }
    }

    // Check if Claude made any commits to the branch
    try {
      const { data: comparison } =
        await octokit.rest.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${baseBranch}...${claudeBranch}`,
        });

      // If there are no commits, check for uncommitted changes if not using commit signing
      if (comparison.total_commits === 0) {
        if (!useCommitSigning) {
          console.log(
            `Branch ${claudeBranch} has no commits from Claude, checking for uncommitted changes...`,
          );

          // Check for uncommitted changes using git status
          try {
            const gitStatus = await $`git status --porcelain`.quiet();
            const hasUncommittedChanges =
              gitStatus.stdout.toString().trim().length > 0;

            if (hasUncommittedChanges) {
              console.log("Found uncommitted changes, committing them...");

              // Add all changes
              await $`git add -A`;

              // Commit with a descriptive message
              const runId = process.env.GITHUB_RUN_ID || "unknown";
              const commitMessage = `Auto-commit: Save uncommitted changes from Claude\n\nRun ID: ${runId}`;
              await $`git commit -m ${commitMessage}`;

              // Push the changes (with retry for transient errors)
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  await $`git push origin ${claudeBranch}`;
                  break;
                } catch (pushErr) {
                  if (attempt === 3) throw pushErr;
                  await new Promise((r) => setTimeout(r, 3000));
                }
              }

              console.log(
                "✅ Successfully committed and pushed uncommitted changes",
              );

              // Set branch link since we now have commits
              const branchUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/tree/${claudeBranch}`;
              branchLink = `\n[View branch](${branchUrl})`;
            } else {
              console.log(
                "No uncommitted changes found, marking branch for deletion",
              );
              shouldDeleteBranch = true;
            }
          } catch (gitError) {
            console.error("Error checking/committing changes:", gitError);
            // If we can't check git status, assume the branch might have changes
            const branchUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/tree/${claudeBranch}`;
            branchLink = `\n[View branch](${branchUrl})`;
          }
        } else {
          console.log(
            `Branch ${claudeBranch} has no commits from Claude, will delete it`,
          );
          shouldDeleteBranch = true;
        }
      } else {
        // Only add branch link if there are commits
        const branchUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/tree/${claudeBranch}`;
        branchLink = `\n[View branch](${branchUrl})`;
      }
    } catch (error) {
      console.error("Error comparing commits on Claude branch:", error);
      // If we can't compare but the branch exists remotely, include the branch link
      const branchUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/tree/${claudeBranch}`;
      branchLink = `\n[View branch](${branchUrl})`;
    }
  }

  // Delete the branch if it has no commits
  if (shouldDeleteBranch && claudeBranch) {
    try {
      await octokit.rest.git.deleteRef({
        owner,
        repo,
        ref: `heads/${claudeBranch}`,
      });
      console.log(`✅ Deleted empty branch: ${claudeBranch}`);
    } catch (deleteError) {
      console.error(`Failed to delete branch ${claudeBranch}:`, deleteError);
      // Continue even if deletion fails
    }
  }

  return { shouldDeleteBranch, branchLink };
}
