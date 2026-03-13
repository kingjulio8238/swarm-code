/**
 * Merge thread branches back into the main branch.
 *
 * Merges are performed sequentially with --no-ff to preserve thread history.
 */

import { execFile } from "node:child_process";
import type { MergeResult, ThreadState } from "../core/types.js";

function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
			} else {
				resolve({ stdout, stderr });
			}
		});
	});
}

/**
 * Merge a single thread branch into the current branch.
 */
export async function mergeThreadBranch(
	repoRoot: string,
	branchName: string,
	threadId: string,
): Promise<MergeResult> {
	try {
		const { stdout } = await git(
			["merge", "--no-ff", "-m", `swarm: merge thread ${threadId}`, branchName],
			repoRoot,
		);

		return {
			success: true,
			branch: branchName,
			conflicts: [],
			message: stdout.trim() || `Merged ${branchName}`,
		};
	} catch (err) {
		const errMsg = String(err);

		// Check for merge conflicts
		if (errMsg.includes("CONFLICT") || errMsg.includes("Merge conflict")) {
			// Get list of conflicted files
			try {
				const { stdout: conflicted } = await git(["diff", "--name-only", "--diff-filter=U"], repoRoot);
				const conflicts = conflicted.trim().split("\n").filter(Boolean);

				// Abort the merge
				await git(["merge", "--abort"], repoRoot);

				return {
					success: false,
					branch: branchName,
					conflicts,
					message: `Merge conflicts in: ${conflicts.join(", ")}`,
				};
			} catch {
				try { await git(["merge", "--abort"], repoRoot); } catch { /* already clean */ }
				return {
					success: false,
					branch: branchName,
					conflicts: [],
					message: errMsg,
				};
			}
		}

		return {
			success: false,
			branch: branchName,
			conflicts: [],
			message: errMsg,
		};
	}
}

/**
 * Merge all completed thread branches sequentially.
 */
export async function mergeAllThreads(
	repoRoot: string,
	threads: ThreadState[],
): Promise<MergeResult[]> {
	const results: MergeResult[] = [];

	const completed = threads.filter(
		(t) => t.status === "completed" && t.branchName && t.result?.success,
	);

	for (const thread of completed) {
		const result = await mergeThreadBranch(repoRoot, thread.branchName!, thread.id);
		results.push(result);

		if (!result.success) {
			// Stop merging on first conflict
			break;
		}
	}

	return results;
}
