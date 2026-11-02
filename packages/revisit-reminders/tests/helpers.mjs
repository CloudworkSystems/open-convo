export function reminder(overrides = {}) {
  const result = {
    id: overrides.id ?? 'garden-plan',
    itemId: overrides.itemId ?? 'session-garden',
    itemKind: overrides.itemKind ?? 'session',
    title: overrides.title ?? 'Come back to the garden plan session',
    when: overrides.when ? { ...overrides.when } : { on: '2026-11-10' },
    createdOn: overrides.createdOn ?? '2026-10-01',
  };
  if (Object.hasOwn(overrides, 'note')) result.note = overrides.note;
  if (Object.hasOwn(overrides, 'snoozedUntil')) result.snoozedUntil = overrides.snoozedUntil;
  if (Object.hasOwn(overrides, 'doneOn')) result.doneOn = overrides.doneOn;
  return result;
}

export function sampleList() {
  return [
    reminder({
      id: 'garden-plan',
      itemId: 'session-garden',
      itemKind: 'session',
      title: 'Come back to the garden plan session',
      when: { on: '2026-10-20' },
      note: 'Check the bean rows.',
      createdOn: '2026-10-01',
    }),
    reminder({
      id: 'seed-list',
      itemId: 'note-seeds',
      itemKind: 'note',
      title: 'Come back to the seed note',
      when: { afterDays: 14, from: '2026-10-19' },
      createdOn: '2026-10-19',
    }),
    reminder({
      id: 'path-link',
      itemId: 'link-path',
      itemKind: 'link',
      title: 'Come back to the path link',
      when: { on: '2026-11-16' },
      createdOn: '2026-10-02',
    }),
    reminder({
      id: 'porch-done',
      itemId: 'note-porch',
      itemKind: 'note',
      title: 'Come back to the porch note',
      when: { on: '2026-09-01' },
      createdOn: '2026-08-01',
      doneOn: '2026-09-02',
    }),
    reminder({
      id: 'shed-later',
      itemId: 'other-shed',
      itemKind: 'other',
      title: 'Come back to the shed list',
      when: { on: '2026-12-01' },
      createdOn: '2026-10-03',
    }),
    reminder({
      id: 'fence-note',
      itemId: 'note-fence',
      itemKind: 'note',
      title: 'Come back to the fence note',
      when: { on: '2026-10-01' },
      createdOn: '2026-09-15',
      snoozedUntil: '2026-11-02',
    }),
  ];
}

export function freeze(list) {
  const copy = list.map(item => {
    const next = { ...item, when: { ...item.when } };
    Object.freeze(next.when);
    return Object.freeze(next);
  });
  return Object.freeze(copy);
}

export function picture(value) {
  return JSON.stringify(value);
}
