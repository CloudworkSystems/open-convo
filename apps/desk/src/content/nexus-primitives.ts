/** Recovered request types, not connected commands or permission to execute. */
export const NEXUS_PRIMITIVES = [
  { name: 'Plan', purpose: 'Turn a request into a proposed goal, steps and a finish line.' },
  { name: 'Build', purpose: 'Carry out a bounded change from a separately accepted plan.' },
  { name: 'Research', purpose: 'Gather evidence and sources for a question.' },
  { name: 'Investigate', purpose: 'Find the cause of a concrete problem and show what was checked.' },
  { name: 'Remember', purpose: 'Keep a chosen detail with its source, scope and memory controls.' },
  { name: 'Delegate', purpose: 'Hand a defined task to an available worker and track its return.' },
  { name: 'Review', purpose: 'Check a specific result and return findings for acceptance or revision.' },
  { name: 'Publish', purpose: 'Send or release an accepted result through a separately approved route.' },
] as const;

export const NEXUS_PRIMITIVE_AVAILABILITY = 'Planned · not connected';
