# Example: Content Management System

A complete example showing how to build a CMS with `latticesql` — authors, posts, tags, and generated context files for LLM-assisted content operations.

---

## Scenario

A content team wants:

- A SQLite-backed CMS storing authors, posts, and tags
- Markdown context files that LLMs can read for drafting, editing, and summarisation tasks
- A custom render function for the posts index (too complex for a built-in template)
- A multi-table view that produces one context file per author

---

## Project structure

```
my-cms/
├── lattice.config.yml
├── src/
│   ├── db.ts
│   └── content.ts
├── context/
│   ├── AUTHORS.md
│   ├── POSTS.md
│   └── authors/
│       ├── alice.md
│       └── bob.md
├── data/
│   └── cms.db
└── generated/
    ├── types.ts
    └── migration.sql
```

---

## 1. Schema

```yaml
# lattice.config.yml
db: ./data/cms.db

entities:
  author:
    fields:
      id: { type: uuid, primaryKey: true }
      slug: { type: text, required: true }
      name: { type: text, required: true }
      email: { type: text, required: true }
      bio: { type: text }
      active: { type: boolean, default: 1 }
    render: default-table
    outputFile: context/AUTHORS.md

  tag:
    fields:
      id: { type: uuid, primaryKey: true }
      label: { type: text, required: true }
    render: default-list
    outputFile: context/TAGS.md

  post:
    fields:
      id: { type: uuid, primaryKey: true }
      slug: { type: text, required: true }
      title: { type: text, required: true }
      excerpt: { type: text }
      status: { type: text, default: draft }
      author_id: { type: uuid, ref: author }
      word_count: { type: integer, default: 0 }
      published_at: { type: datetime }
      updated_at: { type: datetime }
    render:
      template: default-detail
      formatRow: '**{{title}}** [{{status}}] by {{author.name}} — {{word_count}} words'
    outputFile: context/POSTS.md
```

---

## 2. Generate and migrate

```sh
npx lattice generate --out src/generated
```

Then apply the generated SQL to your database on first run.

---

## 3. Database and custom render

The `post` entity uses the `default-detail` template with a `formatRow` hook from the YAML config. But for the per-author context files, we need a custom multi-table view that can't be expressed in YAML:

```ts
// src/db.ts
import { Lattice } from 'latticesql';

export const db = new Lattice({
  config: './lattice.config.yml',
  options: { wal: true },
});

// Per-author context files — one file per author
db.defineMulti('author-context', {
  keys: () => db.query('author', { where: { active: 1 } }),

  outputFile: (author) => `context/authors/${author.slug as string}.md`,

  tables: ['post'],

  render: (author, tables) => {
    const authorPosts = (tables.post ?? [])
      .filter((p) => p.author_id === author.id)
      .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));

    const published = authorPosts.filter((p) => p.status === 'published');
    const drafts = authorPosts.filter((p) => p.status === 'draft');

    const lines: string[] = [
      `# ${author.name as string}`,
      '',
      author.bio ? `${author.bio as string}` : '',
      '',
      `**Published:** ${published.length} posts`,
      `**Drafts:** ${drafts.length} posts`,
      '',
      '## Recent Posts',
      '',
      ...published
        .slice(0, 5)
        .map(
          (p) =>
            `- **${p.title as string}** — ${(p.published_at as string) ?? 'unpublished'} (${p.word_count as number} words)`,
        ),
    ];

    if (drafts.length > 0) {
      lines.push('', '## Drafts', '');
      for (const draft of drafts) {
        lines.push(`- ${draft.title as string} _(${draft.word_count as number} words)_`);
      }
    }

    return lines.filter((l) => l !== null).join('\n');
  },
});

await db.init({
  migrations: [
    {
      version: 1,
      sql: 'ALTER TABLE post ADD COLUMN featured INTEGER DEFAULT 0',
    },
  ],
});
```

---

## 4. Content operations

```ts
// src/content.ts
import { db } from './db.js';

// --- Authors ---

export async function createAuthor(opts: {
  slug: string;
  name: string;
  email: string;
  bio?: string;
}) {
  return db.insert('author', {
    ...opts,
    bio: opts.bio ?? null,
    active: 1,
  });
}

// --- Posts ---

export async function createDraft(opts: {
  slug: string;
  title: string;
  excerpt?: string;
  authorId: string;
}) {
  return db.insert('post', {
    ...opts,
    excerpt: opts.excerpt ?? null,
    status: 'draft',
    author_id: opts.authorId,
    word_count: 0,
    updated_at: new Date().toISOString(),
  });
}

export async function updatePost(
  id: string,
  content: { title?: string; excerpt?: string; wordCount?: number },
) {
  await db.update('post', id, {
    ...(content.title ? { title: content.title } : {}),
    ...(content.excerpt ? { excerpt: content.excerpt } : {}),
    ...(content.wordCount ? { word_count: content.wordCount } : {}),
    updated_at: new Date().toISOString(),
  });
}

export async function publishPost(id: string) {
  await db.update('post', id, {
    status: 'published',
    published_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

export async function getPublishedPosts(authorId?: string) {
  if (authorId) {
    return db.query('post', {
      where: { status: 'published', author_id: authorId },
      orderBy: 'published_at',
      orderDir: 'desc',
    });
  }
  return db.query('post', {
    where: { status: 'published' },
    orderBy: 'published_at',
    orderDir: 'desc',
  });
}

export async function searchPosts(query: string) {
  return db.query('post', {
    filters: [
      { col: 'title', op: 'like', val: `%${query}%` },
      { col: 'status', op: 'ne', val: 'archived' },
    ],
  });
}

export async function getLongPosts(minWords = 1000) {
  return db.query('post', {
    filters: [
      { col: 'word_count', op: 'gte', val: minWords },
      { col: 'status', op: 'eq', val: 'published' },
    ],
    orderBy: 'word_count',
    orderDir: 'desc',
  });
}

// --- Tags (upsert by label) ---

export async function findOrCreateTag(label: string) {
  return db.upsertBy('tag', 'label', label, {});
}

// --- Stats ---

export async function getCMSStats() {
  const [totalPosts, publishedPosts, draftPosts, totalAuthors] = await Promise.all([
    db.count('post'),
    db.count('post', { where: { status: 'published' } }),
    db.count('post', { where: { status: 'draft' } }),
    db.count('author', { where: { active: 1 } }),
  ]);
  return { totalPosts, publishedPosts, draftPosts, totalAuthors };
}
```

---

## 5. Sync loop

```ts
import { db } from './db.js';

// Render on demand after writes:
await db.render('./context');

// Or watch with a longer interval (content changes slowly):
const stop = await db.watch('./context', {
  interval: 60_000, // 1 minute
  onRender: (r) => {
    if (r.filesWritten.length > 0) {
      console.log(`[cms] Context updated: ${r.filesWritten.join(', ')}`);
    }
  },
});
```

---

## 6. Sample context output

**`context/POSTS.md`** (rendered by `default-detail` with `formatRow`):

```markdown
# post

## post-1

**How Lattice Works** [published] by Alice — 1240 words

## post-2

**Getting Started with AI Agents** [published] by Bob — 980 words

## post-3

**Draft: Advanced Query Patterns** [draft] by Alice — 340 words
```

**`context/authors/alice.md`** (multi-table custom render):

```markdown
# Alice

Senior technical writer with a focus on developer tooling.

**Published:** 12 posts
**Drafts:** 2 posts

## Recent Posts

- **How Lattice Works** — 2026-03-15 (1240 words)
- **Building Context-Aware AI Systems** — 2026-03-01 (1800 words)

## Drafts

- Advanced Query Patterns _(340 words)_
- Template Rendering Deep Dive _(120 words)_
```

An LLM given access to `context/authors/alice.md` immediately knows Alice's recent work, what she's drafted, and can assist with writing, editing, or summarising without querying the database.

---

## 7. Using the escape hatch for raw queries

For complex queries not covered by the Lattice API — for example, joining posts to tags through a join table — use the `db.db` escape hatch:

```ts
// Get posts with their tag labels (join table not modelled in Lattice)
const stmt = db.db.prepare(`
  SELECT p.id, p.title, GROUP_CONCAT(t.label) as tags
  FROM post p
  LEFT JOIN post_tag pt ON pt.post_id = p.id
  LEFT JOIN tag t ON t.id = pt.tag_id
  WHERE p.status = 'published'
  GROUP BY p.id
  ORDER BY p.published_at DESC
  LIMIT ?
`);

const recentWithTags = stmt.all(10) as Array<{ id: string; title: string; tags: string }>;
```

The escape hatch bypasses Lattice sanitization and audit logging — use it only for read-only analytics queries.
