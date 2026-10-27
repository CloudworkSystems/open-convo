export function mail(fields = {}) {
  return {
    id: 'm-1',
    inbox: 'home',
    from: { name: 'Tessa Vale', address: 'tessa@fernway.example' },
    to: [{ address: 'reader@quillhome.example' }],
    subject: 'Hello',
    date: '2026-10-24T12:00:00Z',
    snippet: 'Invented mail.',
    headers: {},
    pile: 'other',
    ...fields,
  };
}

export function messages(values) {
  return { schemaVersion: 1, messages: values };
}

export function requests(values) {
  return { schemaVersion: 1, requests: values };
}

export function request(action, target, pile) {
  return { action, target, ...(pile === undefined ? {} : { pile }) };
}

export function action(plan, name) {
  return plan.actions.find(value => value.action === name);
}

export function resultMessage(plan, actionName, id) {
  const found = action(plan, actionName).groups.flatMap(group => group.messages)
    .filter(message => Object.values(message.ids).flat().includes(id));
  if (found.length !== 1) throw new Error(`Expected one ${actionName} message ${id}; found ${found.length}.`);
  return found[0];
}
