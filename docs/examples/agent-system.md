# Example: AI Agent System

A complete example showing how to use `latticesql` as the persistent memory layer for a multi-agent AI system.

---

## Scenario

You have several specialised AI agents (Craft, Audit, Research, etc.). Each agent has a persistent profile and an assigned task list. You want:

- A SQLite database tracking agents, tasks, and events
- Auto-generated LLM context files so each agent can read its current state
- A writeback channel so agents can append new tasks by writing to a file
- Audit logging for all database mutations

---

## Project structure

```
my-agent-system/
├── lattice.config.yml
├── src/
│   └── db.ts
├── context/
│   ├── AGENTS.md
│   └── TASKS.md
├── data/
│   └── agents.db
└── generated/
    ├── types.ts
    └── migration.sql
```

---

## 1. Define the schema

```yaml
# lattice.config.yml
db: ./data/agents.db

entities:
  agent:
    fields:
      id: { type: uuid, primaryKey: true }
      slug: { type: text, required: true }
      name: { type: text, required: true }
      role: { type: text, required: true }
      status: { type: text, default: active }
      model: { type: text, default: claude-sonnet-4-6 }
      created_at: { type: datetime }
    render: default-table
    outputFile: context/AGENTS.md

  task:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text, required: true }
      description: { type: text }
      status: { type: text, default: pending }
      priority: { type: integer, default: 1 }
      agent_id: { type: uuid, ref: agent }
      created_at: { type: datetime }
      completed_at: { type: datetime }
    render:
      template: default-list
      formatRow: '[{{status}}] {{title}} → {{agent.name}}'
    outputFile: context/TASKS.md

  event:
    fields:
      id: { type: uuid, primaryKey: true }
      type: { type: text, required: true }
      agent_id: { type: uuid, ref: agent }
      payload: { type: text }
      created_at: { type: datetime }
    render:
      template: default-list
      formatRow: '{{created_at}} [{{type}}] {{agent.name}}'
    outputFile: context/EVENTS.md
```

---

## 2. Generate types and migration

```sh
npx lattice generate
```

Produces `generated/types.ts`:

```ts
export interface Agent {
  id: string;
  slug: string;
  name: string;
  role: string;
  status?: string;
  model?: string;
  created_at?: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status?: string;
  priority?: number;
  agent_id?: string; // → agent
  created_at?: string;
  completed_at?: string;
}

export interface Event {
  id: string;
  type: string;
  agent_id?: string; // → agent
  payload?: string;
  created_at?: string;
}
```

---

## 3. Set up the database

```ts
// src/db.ts
import { Lattice } from 'latticesql';

export const db = new Lattice({ config: './lattice.config.yml' });

db.on('audit', (event) => {
  console.log(`[audit] ${event.operation} ${event.table}:${event.id} at ${event.timestamp}`);
});

db.on('render', (result) => {
  console.log(`[render] Wrote ${result.filesWritten.length} file(s) in ${result.durationMs}ms`);
});
```

---

## 4. Seed agents

```ts
import { db } from './db.js';

async function seedAgents() {
  await db.init();

  const agents = [
    { id: 'agent-craft', slug: 'craft', name: 'Craft', role: 'Software architect and implementer' },
    { id: 'agent-audit', slug: 'audit', name: 'Audit', role: 'Code reviewer and security analyst' },
    {
      id: 'agent-research',
      slug: 'research',
      name: 'Research',
      role: 'Technical researcher and planner',
    },
  ];

  for (const agent of agents) {
    await db.upsert('agent', {
      ...agent,
      status: 'active',
      model: 'claude-sonnet-4-6',
      created_at: new Date().toISOString(),
    });
  }

  console.log('Agents seeded.');
}

seedAgents();
```

---

## 5. Assign and complete tasks

```ts
import { db } from './db.js';

// Create a task
const taskId = await db.insert('task', {
  title: 'Add rate limiting to the API',
  description: 'Implement token bucket rate limiting on /api/* routes',
  status: 'pending',
  priority: 2,
  agent_id: 'agent-craft',
  created_at: new Date().toISOString(),
});

// Query open tasks for an agent
const craftTasks = await db.query('task', {
  where: { agent_id: 'agent-craft', status: 'pending' },
  orderBy: 'priority',
  orderDir: 'desc',
});

// Mark a task complete
await db.update('task', taskId, {
  status: 'done',
  completed_at: new Date().toISOString(),
});

// Count by status
const openCount = await db.count('task', { where: { status: 'pending' } });
const doneCount = await db.count('task', { where: { status: 'done' } });
console.log(`Tasks: ${openCount} open, ${doneCount} done`);
```

---

## 6. Writeback: let agents append tasks

Agents can write to a shared inbox file. Lattice reads it back and inserts into the database.

```ts
import { db } from './db.js';

// Register the writeback pipeline
db.defineWriteback({
  file: './context/INBOX.md',
  parse: (content, fromOffset) => {
    const newContent = content.slice(fromOffset);
    const entries: { title: string; agentSlug: string }[] = [];

    // Parse lines like: "- TASK: [agent-slug] Task title here"
    for (const line of newContent.split('\n')) {
      const match = line.match(/^- TASK: \[([^\]]+)\] (.+)$/);
      if (match) {
        entries.push({ agentSlug: match[1]!, title: match[2]! });
      }
    }

    return { entries, nextOffset: content.length };
  },
  persist: async (entry) => {
    const { title, agentSlug } = entry as { title: string; agentSlug: string };
    // Look up the agent by slug
    const [agent] = await db.query('agent', { where: { slug: agentSlug } });
    await db.insert('task', {
      title,
      status: 'pending',
      priority: 1,
      agent_id: agent?.id ?? null,
      created_at: new Date().toISOString(),
    });
  },
  dedupeKey: (entry) => {
    const { title, agentSlug } = entry as { title: string; agentSlug: string };
    return `${agentSlug}:${title}`;
  },
});
```

Now any agent that writes `- TASK: [craft] Refactor auth middleware` to `context/INBOX.md` will have it automatically picked up on the next sync cycle.

---

## 7. Start the sync loop

```ts
import { db } from './db.js';

await db.init();

// Render once immediately:
await db.render('./context');

// Then watch with a 10-second interval:
const stop = await db.watch('./context', {
  interval: 10_000,
  onError: (err) => console.error('Sync error:', err),
});

// Graceful shutdown:
process.on('SIGTERM', () => {
  stop();
  db.close();
});
```

---

## 8. What the context files look like

**`context/AGENTS.md`** (rendered by `default-table`):

```markdown
# agent

| id          | slug  | name  | role               | status | model             |
| ----------- | ----- | ----- | ------------------ | ------ | ----------------- |
| agent-craft | craft | Craft | Software architect | active | claude-sonnet-4-6 |
| agent-audit | audit | Audit | Code reviewer      | active | claude-sonnet-4-6 |
```

**`context/TASKS.md`** (rendered by `default-list` with `formatRow`):

```markdown
# task

- [pending] Add rate limiting to the API → Craft
- [done] Write migration guide → Audit
- [pending] Research vector search options → Research
```

These files are what the agents read at the start of each conversation — structured, compact, and automatically kept in sync with the database.
