import { indexOfId, type ReplaySession } from "../replay/model.ts"

/**
 * Files related to `path` in this session (GOAL §12): touched in the same scene.
 * Same-directory relations are already visible as regions. Computed on demand; the map only draws them on hover
 * or selection.
 */
export const relatedFiles = (replay: ReplaySession, path: string): ReadonlyArray<string> => {
  const file = replay.files.get(path)
  if (file === undefined) return []
  const related = new Set<string>()
  for (const id of file.sceneIds) {
    const scene = replay.scenes[indexOfId(id)]
    for (const other of scene?.filePaths ?? []) if (other !== path) related.add(other)
  }
  return [...related]
}
