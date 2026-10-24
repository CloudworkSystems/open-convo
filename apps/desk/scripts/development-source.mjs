import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

// Fixed source manifests: no ignore-file inference, globs or directory copy.
// Adding another test/helper requires naming its source explicitly here.
export const DEVELOPMENT_SOURCE_FILES = Object.freeze([
  'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts',
  'src/main.tsx', 'src/app/App.tsx', 'src/app/recovery.css', 'src/app/preview-updates.ts',
  'src/app/runtime.tsx', 'src/app/native-bootstrap.ts',
  'src/app/use-conversation-runs.tsx', 'src/adapters/participant-runtime.ts',
  'src/domain/conversation-run-types.ts', 'src/domain/conversation-runs.ts', 'src/domain/conversation-workspace.ts',
  'src/domain/participant-choices.ts', 'src/domain/local-participant.ts', 'src/features/ParticipantPicker.tsx', 'src/features/participant-picker.css',
  'src/features/RunTranscript.tsx', 'src/features/run-transcript.css',
  'src/adapters/workspace-repository.ts', 'src/adapters/native-proof-repository.ts',
  'src/adapters/native-host-client.ts', 'src/adapters/native-host-codec.ts', 'src/adapters/wk-host-transport.ts',
  'src/adapters/native-participant-codec.ts', 'src/adapters/native-participant-port.ts',
  'src/adapters/dictation-draft.ts', 'src/adapters/native-dictation.ts', 'src/app/use-desk-dictation.tsx',
  'src/adapters/browser-repository.ts', 'src/adapters/browser-tab-view.ts', 'src/adapters/browser-layout.ts', 'src/domain/types.ts',
  'src/adapters/browser-roadmap.ts', 'src/adapters/indexeddb-record.ts', 'src/domain/recovery-roadmap.ts', 'src/content/recovery-roadmap.json',
  'src/adapters/browser-identity.ts', 'src/features/useBrowserIdentity.ts',
  'src/adapters/browser-canvas.ts', 'src/domain/canvas-layout.ts', 'src/domain/folder-icons.ts', 'src/domain/folder-paths.ts',
  'src/features/AvatarCrop.tsx', 'src/features/avatar-crop.ts', 'src/features/user-options.css',
  'src/content/nexus-primitives.ts', 'src/features/NexusPrimitives.tsx', 'src/features/nexus-primitives.css',
  'src/domain/commands.ts', 'src/domain/demo.ts', 'src/domain/validation.ts', 'src/domain/session-naming.ts',
  'src/domain/history-reader.ts', 'src/domain/memory.ts',
  'src/features/Conversation.tsx', 'src/features/DeskFoundation.tsx',
  'src/features/GoalPanel.tsx', 'src/features/Modules.tsx',
  'src/features/HistoryReader.tsx', 'src/features/history-reader.css',
  'src/features/MemoryPage.tsx', 'src/features/memory.css',
  'src/features/domain-note.css', 'src/features/composer.css', 'src/features/workspace-layout.css',
  'src/features/RoadmapBoard.tsx', 'src/features/roadmap.css',
  'src/features/Navigation.tsx', 'src/features/UserOptions.tsx', 'src/features/NexusViews.tsx',
  'src/features/RailMap.tsx', 'src/features/rail-map.css', 'src/domain/rail-map.ts', 'src/content/rail-map.json', 'src/shell/foundation.css', 'src/shell/nexus.css',
  'src/ui/Icon.tsx', 'src/ui/Modal.tsx', 'src/ui/ResizeHandle.tsx',
  'src/ui/FolderIcon.tsx', 'src/ui/modal.css', 'src/ui/lucide/LICENSE',
  'brand/tokens.css', 'brand/logo.png', 'brand/fonts/fonts.css',
  'brand/fonts/OFL-atkinsonhyperlegiblenext.txt', 'brand/fonts/OFL-jetbrainsmono.txt',
  'brand/fonts/atkinson-hyperlegible-next-00.woff2',
  'brand/fonts/atkinson-hyperlegible-next-01.woff2',
  'brand/fonts/atkinson-hyperlegible-next-02.woff2',
  'brand/fonts/atkinson-hyperlegible-next-03.woff2',
  'brand/fonts/jetbrains-mono-00.woff2', 'brand/fonts/jetbrains-mono-01.woff2',
  'brand/fonts/jetbrains-mono-02.woff2', 'brand/fonts/jetbrains-mono-03.woff2',
  'brand/fonts/jetbrains-mono-04.woff2', 'brand/fonts/jetbrains-mono-05.woff2',
  'brand/fonts/jetbrains-mono-06.woff2', 'brand/fonts/jetbrains-mono-07.woff2',
  'brand/fonts/jetbrains-mono-08.woff2', 'brand/fonts/jetbrains-mono-09.woff2',
  'brand/fonts/jetbrains-mono-10.woff2', 'brand/fonts/jetbrains-mono-11.woff2',
]);

const permitted = new Set(DEVELOPMENT_SOURCE_FILES);

function directory(path, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a directory, not a symlink.`);
  return realpathSync(path);
}

function checkedPath(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath)
    || /[\\:\0]/.test(relativePath) || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Source path must stay inside the explicitly permitted source tree.');
  }
  if (!permitted.has(relativePath)) throw new Error(`Source file is not on the fixed allowlist: ${relativePath}`);
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}${sep}`)) throw new Error('Source path escapes its source tree.');
  return path;
}

function sourceFile(root, relativePath) {
  const path = checkedPath(root, relativePath);
  const parts = relativePath.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    directory(join(root, ...parts.slice(0, index)), `Source parent for ${relativePath}`);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error(`Source must be a regular file, not a symlink or hardlink: ${relativePath}`);
  if (!realpathSync(path).startsWith(`${root}${sep}`)) throw new Error('Source file escapes its source tree.');
  return path;
}

/** Copy only enumerated regular source files. Unknown files are never inspected. */
export function copyAllowedSourceFiles(sourceRoot, destinationRoot, relativePaths = DEVELOPMENT_SOURCE_FILES) {
  const source = directory(resolve(sourceRoot), 'Source root');
  const destination = directory(resolve(destinationRoot), 'Destination root');
  if (new Set(relativePaths).size !== relativePaths.length) throw new Error('Source manifest contains duplicate paths.');
  // Validate the complete input before opening any source contents.
  const paths = relativePaths.map((path) => ({ name: path, source: sourceFile(source, path) }));
  for (const path of paths) {
    const target = checkedPath(destination, path.name);
    const parts = path.name.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = join(destination, ...parts.slice(0, index));
      mkdirSync(parent, { recursive: true });
      const canonical = directory(parent, `Destination parent for ${path.name}`);
      if (!canonical.startsWith(`${destination}${sep}`)) throw new Error('Destination parent escapes its source tree.');
    }
    const descriptor = openSync(path.source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== 1) throw new Error(`Source must remain a regular file without hardlinks: ${path.name}`);
      // Exclusive creation refuses an existing output, including a symlink.
      writeFileSync(target, readFileSync(descriptor), { flag: 'wx', mode: 0o600 });
    } finally {
      closeSync(descriptor);
    }
  }
  return paths.map((path) => path.name);
}
