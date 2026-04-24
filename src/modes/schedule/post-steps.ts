import { spawn } from "child_process";
import type { PostStep } from "./types";

export async function runPostSteps(
  postSteps: PostStep[],
  workingDir?: string,
): Promise<void> {
  if (!postSteps.length) return;

  const cwd =
    workingDir || process.env.GITHUB_WORKSPACE || process.cwd();

  for (const step of postSteps) {
    console.log(`\n▶ Post-step: ${step.name}`);
    await runStep(step, cwd);
  }
}

function runStep(step: PostStep, cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const env = { ...process.env, ...(step.env ?? {}) };
    const child = spawn("bash", ["-c", step.run], {
      stdio: "inherit",
      cwd,
      env,
    });
    child.on("close", (code) => {
      if (code === 0) {
        console.log(`✅ Post-step "${step.name}" succeeded`);
        resolve();
      } else {
        reject(
          new Error(`Post-step "${step.name}" exited with code ${code}`),
        );
      }
    });
    child.on("error", reject);
  });
}
