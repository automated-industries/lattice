import { describe, it, expect } from 'vitest';
import { SchemaManager } from '../../src/schema/manager.js';
import type { BelongsToRelation, HasManyRelation } from '../../src/types.js';

function makeManager(): SchemaManager {
  return new SchemaManager();
}

describe('Relationship declarations', () => {
  // -------------------------------------------------------------------------
  // belongsTo
  // -------------------------------------------------------------------------

  it('stores a belongsTo relation on the table', () => {
    const mgr = makeManager();
    mgr.define('comments', {
      columns: { id: 'TEXT PRIMARY KEY', post_id: 'TEXT', body: 'TEXT' },
      render: () => '',
      outputFile: 'comments.md',
      relations: {
        post: { type: 'belongsTo', table: 'posts', foreignKey: 'post_id' },
      },
    });

    const rels = mgr.getRelations('comments');
    const rel = rels['post'] as BelongsToRelation;
    expect(rel).toBeDefined();
    expect(rel.type).toBe('belongsTo');
    expect(rel.table).toBe('posts');
    expect(rel.foreignKey).toBe('post_id');
    expect(rel.references).toBeUndefined(); // no explicit references
  });

  it('stores a belongsTo relation with an explicit references column', () => {
    const mgr = makeManager();
    mgr.define('orders', {
      columns: { id: 'TEXT PRIMARY KEY', customer_email: 'TEXT' },
      render: () => '',
      outputFile: 'orders.md',
      relations: {
        customer: {
          type: 'belongsTo',
          table: 'customers',
          foreignKey: 'customer_email',
          references: 'email',
        },
      },
    });

    const rel = mgr.getRelations('orders')['customer'] as BelongsToRelation;
    expect(rel.references).toBe('email');
  });

  // -------------------------------------------------------------------------
  // hasMany
  // -------------------------------------------------------------------------

  it('stores a hasMany relation on the table', () => {
    const mgr = makeManager();
    mgr.define('posts', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT' },
      render: () => '',
      outputFile: 'posts.md',
      relations: {
        comments: { type: 'hasMany', table: 'comments', foreignKey: 'post_id' },
      },
    });

    const rels = mgr.getRelations('posts');
    const rel = rels['comments'] as HasManyRelation;
    expect(rel).toBeDefined();
    expect(rel.type).toBe('hasMany');
    expect(rel.table).toBe('comments');
    expect(rel.foreignKey).toBe('post_id');
  });

  it('stores a hasMany relation with an explicit references column', () => {
    const mgr = makeManager();
    mgr.define('teams', {
      columns: { slug: 'TEXT PRIMARY KEY', name: 'TEXT' },
      primaryKey: 'slug',
      render: () => '',
      outputFile: 'teams.md',
      relations: {
        members: {
          type: 'hasMany',
          table: 'users',
          foreignKey: 'team_slug',
          references: 'slug',
        },
      },
    });

    const rel = mgr.getRelations('teams')['members'] as HasManyRelation;
    expect(rel.references).toBe('slug');
  });

  // -------------------------------------------------------------------------
  // Multiple relations on one table
  // -------------------------------------------------------------------------

  it('stores multiple relations on the same table', () => {
    const mgr = makeManager();
    mgr.define('posts', {
      columns: { id: 'TEXT PRIMARY KEY', author_id: 'TEXT' },
      render: () => '',
      outputFile: 'posts.md',
      relations: {
        author:   { type: 'belongsTo', table: 'users',    foreignKey: 'author_id' },
        comments: { type: 'hasMany',   table: 'comments', foreignKey: 'post_id'   },
        tags:     { type: 'hasMany',   table: 'post_tags', foreignKey: 'post_id'  },
      },
    });

    const rels = mgr.getRelations('posts');
    expect(Object.keys(rels)).toHaveLength(3);
    expect((rels['author'] as BelongsToRelation).type).toBe('belongsTo');
    expect((rels['comments'] as HasManyRelation).type).toBe('hasMany');
    expect((rels['tags'] as HasManyRelation).table).toBe('post_tags');
  });

  // -------------------------------------------------------------------------
  // No relations
  // -------------------------------------------------------------------------

  it('returns an empty object for a table with no relations declared', () => {
    const mgr = makeManager();
    mgr.define('standalone', {
      columns: { id: 'TEXT PRIMARY KEY', value: 'TEXT' },
      render: () => '',
      outputFile: 'standalone.md',
    });

    expect(mgr.getRelations('standalone')).toEqual({});
  });

  it('returns an empty object for a table name not in the registry', () => {
    const mgr = makeManager();
    expect(mgr.getRelations('nonexistent')).toEqual({});
  });

  // -------------------------------------------------------------------------
  // Relations are independent of primaryKey
  // -------------------------------------------------------------------------

  it('relations work correctly with custom primaryKey', () => {
    const mgr = makeManager();
    mgr.define('articles', {
      columns: { slug: 'TEXT PRIMARY KEY', headline: 'TEXT' },
      primaryKey: 'slug',
      render: () => '',
      outputFile: 'articles.md',
      relations: {
        revisions: { type: 'hasMany', table: 'revisions', foreignKey: 'article_slug', references: 'slug' },
      },
    });

    const pk = mgr.getPrimaryKey('articles');
    expect(pk).toEqual(['slug']);

    const rel = mgr.getRelations('articles')['revisions'] as HasManyRelation;
    expect(rel.foreignKey).toBe('article_slug');
    expect(rel.references).toBe('slug');
  });

  // -------------------------------------------------------------------------
  // Type integrity — relation objects are stored verbatim
  // -------------------------------------------------------------------------

  it('relation objects are stored by reference (no mutation)', () => {
    const mgr = makeManager();
    const relDef: BelongsToRelation = {
      type: 'belongsTo',
      table: 'users',
      foreignKey: 'user_id',
    };
    mgr.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', user_id: 'TEXT' },
      render: () => '',
      outputFile: 'tasks.md',
      relations: { owner: relDef },
    });

    expect(mgr.getRelations('tasks')['owner']).toBe(relDef);
  });
});
