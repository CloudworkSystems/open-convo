import type { Goal } from './types';

/** Show recorded ancestry without changing folder identities or ordering. */
export function folderOptions(goals: Goal[]): { id: string; label: string }[] {
  const paths = goals.map((folder) => {
    const names: string[] = [];
    const seen = new Set<string>();
    let current: Goal | undefined = folder;
    while (current && !seen.has(current.id)) {
      names.unshift(current.title); seen.add(current.id);
      current = goals.find((item) => item.id === current?.parentId);
    }
    return { id: folder.id, label: names.join(' / ') };
  });
  return paths.map((folder, index) => {
    const duplicates = paths.filter((item) => item.label === folder.label);
    return { ...folder, label: duplicates.length > 1
      ? `${folder.label} (${paths.slice(0, index + 1).filter((item) => item.label === folder.label).length})`
      : folder.label };
  });
}
