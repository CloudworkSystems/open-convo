/** Stable, local choices. Missing icon retains the original Desk folder symbol. */
export const folderIconChoices = [
  { value: 'default', label: 'Folder' },
  { value: 'book-open', label: 'Book' },
  { value: 'briefcase', label: 'Briefcase' },
  { value: 'lightbulb', label: 'Idea' },
  { value: 'heart', label: 'Heart' },
  { value: 'star', label: 'Star' },
  { value: 'house', label: 'Home' },
] as const;

export type FolderIconName = (typeof folderIconChoices)[number]['value'];
export function isFolderIcon(value: unknown): value is FolderIconName {
  return typeof value === 'string' && folderIconChoices.some((choice) => choice.value === value);
}
