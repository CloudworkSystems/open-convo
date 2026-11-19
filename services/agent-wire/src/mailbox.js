import { fail, UNKNOWN, RESTORING, FULL, EMPTY, NO_AGENTS } from './errors.js';
import { check, agentSchema, schemas, plainText, bytes } from './schema.js';

export const ROLE_TOOLS = {
  agent: ['leave_note', 'read_notes'],
  assistant: ['list_notes', 'draft_reply'],
  owner: ['list_notes', 'answer_note', 'clear_notes', 'add_agent', 'switch_agent', 'remove_agent', 'list_agents', 'list_drafts', 'send_draft', 'export_notes', 'begin_import', 'import_note', 'finish_import'],
};
export const sorted = (notes) => notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
const listed = (notes) => ({ notes, ...(notes.length ? {} : { message: EMPTY }) });

export class Mailbox {
  constructor(store, config, now = Date.now) {
    this.store = store;
    this.config = config;
    this.now = now;
    this.schemas = schemas(config);
  }
  principal(identity) {
    if (identity === this.config.owner) return { agent: 'owner', role: 'owner', identity };
    const agent = this.store.all('agent').find((a) => a.identity === identity && a.on && !a.removed);
    if (!agent) fail(UNKNOWN, 403);
    if (this.store.get('meta', 'restore')) fail(RESTORING, 503);
    return agent;
  }
  calls(principal, method, name) {
    const importing = this.store.get('meta', 'restore');
    if (principal.role === 'owner' && importing && method === 'tools/call' && ['import_note', 'finish_import'].includes(name)) return;
    this.rate(principal.agent, 'calls', this.config.CALLS_PER_MINUTE, 60000);
  }
  rate(agent, kind, limit, window) {
    const key = agent + ':' + kind;
    const times = (this.store.get('rate', key) ?? []).filter((t) => t > this.now() - window);
    if (times.length >= limit) {
      const minutes = Math.max(1, Math.ceil((times[0] + window - this.now()) / 60000));
      fail(`Too many notes for now. Try again in ${minutes} minutes.`, 429);
    }
    this.store.put('rate', key, [...times, this.now()]);
  }
  known(name) { return name === 'owner' || !!this.store.get('agent', name); }
  recipient(name) {
    if (name === 'owner') return;
    const agent = this.store.get('agent', name);
    if (!agent || !agent.on || agent.removed) fail('That recipient cannot receive notes right now.');
  }
  note(id) {
    const note = this.store.get('note', id);
    if (!note) fail('That note is no longer here.');
    return note;
  }
  capacity() { if (this.store.count('note') >= this.config.NOTE_CAP) fail(FULL, 409); }
  saveNote(note) {
    this.capacity();
    plainText(note.subject);
    plainText(note.body);
    // Guarantee that every accepted note can later be restored in one call.
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'import_note', arguments: { note } } };
    if (bytes(JSON.stringify(request)) > this.config.REQUEST_BYTES) fail('This text needs too much space to back up safely. Shorten it and try again.');
    this.store.put('note', note.id, note);
    return { note };
  }
  reply(original, body) {
    this.recipient(original.from);
    const note = { id: crypto.randomUUID(), from: 'owner', to: original.from, subject: original.subject, body, createdAt: new Date(this.now()).toISOString(), inReplyTo: original.id };
    return this.saveNote(note);
  }
  validateAgents(agents) {
    const names = new Set();
    const identities = new Set();
    for (const agent of agents) {
      check(agentSchema, agent);
      if (agent.agent === 'owner' || agent.identity === this.config.owner || names.has(agent.agent) || identities.has(agent.identity) || (agent.removed && agent.on)) {
        fail('Agent names and identities must be different and cannot be the owner.');
      }
      names.add(agent.agent);
      identities.add(agent.identity);
    }
    for (const agent of agents) {
      if (agent.mayWriteTo.some((name) => name !== 'owner' && !names.has(name))) fail('Choose recipients already on the agent list.');
    }
    if (bytes(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'begin_import', arguments: { agents } } })) > this.config.REQUEST_BYTES) {
      fail('This agent list needs too much space to restore safely. Use fewer agents or recipients.');
    }
  }
  run(principal, name, args) {
    if (!ROLE_TOOLS[principal.role].includes(name)) fail('This sign-in cannot use that tool.', 403);
    check(this.schemas[name], args);
    const restoring = this.store.get('meta', 'restore');
    if (restoring && !['import_note', 'finish_import', 'export_notes', 'list_notes', 'list_agents', 'list_drafts'].includes(name)) fail(RESTORING, 409);
    switch (name) {
      case 'leave_note': {
        if (!principal.mayWriteTo.includes(args.to)) fail('This agent cannot write to that recipient.', 403);
        this.recipient(args.to);
        if (args.inReplyTo) {
          const original = this.note(args.inReplyTo);
          if (original.to !== principal.agent || original.from !== args.to) fail('Reply only to a note addressed to this agent.', 403);
        }
        // Validate before consuming the hourly send allowance.
        plainText(args.subject);
        plainText(args.body);
        this.capacity();
        this.rate(principal.agent, 'notes', this.config.NOTES_PER_HOUR, 3600000);
        return this.saveNote({ id: crypto.randomUUID(), from: principal.agent, to: args.to, subject: args.subject, body: args.body, createdAt: new Date(this.now()).toISOString(), ...(args.inReplyTo ? { inReplyTo: args.inReplyTo } : {}) });
      }
      case 'read_notes':
      case 'list_notes': {
        const notes = sorted(this.store.all('note').filter((n) =>
          (name !== 'read_notes' || n.to === principal.agent) && (!args.from || n.from === args.from) && (!args.to || n.to === args.to) && (!args.since || n.createdAt > args.since)));
        return listed(notes);
      }
      case 'answer_note': return this.reply(this.note(args.id), args.body);
      case 'clear_notes': {
        // Unknown ids are harmless, and drafts for cleared notes are cleared too.
        for (const id of args.ids) this.store.delete('note', id);
        for (const draft of this.store.all('draft')) if (args.ids.includes(draft.inReplyTo)) this.store.delete('draft', draft.id);
        return { cleared: args.ids.length };
      }
      case 'add_agent': {
        const previous = this.store.get('agent', args.agent);
        if (previous && (!previous.removed || previous.identity !== args.identity)) fail('That agent name is already used.');
        const agent = { ...args, on: true };
        this.validateAgents([...this.store.all('agent').filter((a) => a.agent !== args.agent), agent]);
        this.store.put('agent', args.agent, agent);
        return { agent };
      }
      case 'switch_agent':
      case 'remove_agent': {
        const agent = this.store.get('agent', args.agent);
        if (!agent || agent.removed) fail('That agent is not on the list.');
        const updated = { ...agent, on: name === 'remove_agent' ? false : args.on, ...(name === 'remove_agent' ? { removed: true } : {}) };
        this.store.put('agent', agent.agent, updated);
        return { agent: updated };
      }
      case 'list_agents': {
        const agents = this.store.all('agent').filter((a) => !a.removed).sort((a, b) => a.agent.localeCompare(b.agent));
        return { agents, ...(agents.some((a) => a.on && a.role === 'agent') ? {} : { message: NO_AGENTS }) };
      }
      case 'draft_reply': {
        const original = this.note(args.id);
        this.recipient(original.from);
        plainText(args.body);
        if (this.store.count('draft') >= this.config.NOTE_CAP) fail('There are too many drafts. Ask the mailbox owner to send or clear some.');
        const draft = { id: crypto.randomUUID(), from: 'owner', to: original.from, subject: original.subject, body: args.body, createdAt: new Date(this.now()).toISOString(), inReplyTo: original.id };
        this.store.put('draft', draft.id, draft);
        return { draft, message: 'Draft saved. Only the owner can send it.' };
      }
      case 'list_drafts': return { drafts: sorted(this.store.all('draft')) };
      case 'send_draft': {
        const draft = this.store.get('draft', args.draftId);
        if (!draft) fail('That draft is no longer here.');
        const result = this.reply(this.note(draft.inReplyTo), draft.body);
        this.store.delete('draft', draft.id);
        return result;
      }
      case 'export_notes': {
        // Sort by immutable id for a cursor unaffected by equal timestamps.
        const notes = this.store.all('note').sort((a, b) => a.id.localeCompare(b.id)).filter((n) => !args.after || n.id.localeCompare(args.after) > 0);
        const page = notes.slice(0, 100);
        return { notes: page, agents: this.store.all('agent').sort((a, b) => a.agent.localeCompare(b.agent)), after: notes.length > 100 ? page.at(-1).id : null };
      }
      case 'begin_import': {
        if (restoring || this.store.count('note') || this.store.count('agent') || this.store.count('draft')) fail('Restore needs an empty mailbox with no agents or drafts.');
        this.validateAgents(args.agents);
        for (const agent of args.agents) this.store.put('agent', agent.agent, agent);
        this.store.put('meta', 'restore', { active: true });
        return { message: 'Restore started. Agents cannot use the mailbox until it finishes.' };
      }
      case 'import_note': {
        if (!restoring) fail('Start a restore before importing notes.');
        const note = args.note;
        if (!this.known(note.from) || !this.known(note.to)) fail('This note names someone outside the imported agent list.');
        if (this.store.get('note', note.id)) fail('That note was already imported.');
        return this.saveNote(note);
      }
      case 'finish_import': {
        if (!restoring) fail('There is no restore to finish.');
        if (args.count !== this.store.count('note')) fail('The imported note count does not match. Keep the backup and check the restore.');
        this.store.delete('meta', 'restore');
        return { message: 'Restore finished.', count: args.count };
      }
    }
  }
}
