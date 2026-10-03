import { git, gitOrNull } from "./git.js";

const DOCUMENT_NAME = /^[a-z0-9-]+$/;

export function assertDocumentName(name: string): void {
  if (!DOCUMENT_NAME.test(name)) throw new Error(`invalid document name: ${JSON.stringify(name)}`);
}

/** The document's text at a commit (its single `<name>.json` blob), or null when absent. */
export async function readDocumentAt(
  repo: string,
  commit: string,
  name: string
): Promise<string | null> {
  return gitOrNull(["cat-file", "blob", `${commit}:${name}.json`], { cwd: repo });
}

/** Writes a commit whose tree holds only `<name>.json`; two parents record a sync merge. */
export async function commitDocument(
  repo: string,
  env: NodeJS.ProcessEnv,
  name: string,
  text: string,
  parents: readonly string[],
  message: string
): Promise<string> {
  const blob = (await git(["hash-object", "-w", "--stdin"], { cwd: repo, input: text })).trim();
  const tree = (
    await git(["mktree"], { cwd: repo, input: `100644 blob ${blob}\t${name}.json\n` })
  ).trim();
  const parentArgs = parents.flatMap((p) => ["-p", p]);
  return (
    await git(["commit-tree", tree, ...parentArgs, "-m", message], { cwd: repo, env })
  ).trim();
}
