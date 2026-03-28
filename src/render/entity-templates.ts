/**
 * Entity Render Template Compilation
 *
 * Compiles declarative template objects (entity-table, entity-profile,
 * entity-sections) into (rows: Row[]) => string render functions.
 */

import type { Row } from '../types.js';
import type { EntityRenderSpec, EntityRenderTemplate, EntityTableTemplate, EntityProfileTemplate, EntitySectionsTemplate } from '../schema/entity-context.js';
import { frontmatter, markdownTable, truncate } from './markdown.js';
import { createReadOnlyHeader } from '../session/constants.js';

const DEFAULT_HEADER = createReadOnlyHeader();

/**
 * Compile an EntityRenderSpec into a render function.
 * If already a function, returns it unchanged.
 */
export function compileEntityRender(spec: EntityRenderSpec): (rows: Row[]) => string {
  if (typeof spec === 'function') return spec;
  return compileTemplate(spec);
}

function compileTemplate(tmpl: EntityRenderTemplate): (rows: Row[]) => string {
  switch (tmpl.template) {
    case 'entity-table':
      return compileEntityTable(tmpl);
    case 'entity-profile':
      return compileEntityProfile(tmpl);
    case 'entity-sections':
      return compileEntitySections(tmpl);
  }
}

function compileEntityTable(tmpl: EntityTableTemplate): (rows: Row[]) => string {
  return (rows) => {
    const data = tmpl.beforeRender ? tmpl.beforeRender(rows) : rows;
    let md = DEFAULT_HEADER;
    md += frontmatter(tmpl.frontmatter ?? {});
    md += `# ${tmpl.heading}\n\n`;

    if (data.length === 0) {
      md += tmpl.emptyMessage ?? '*No data.*\n';
    } else {
      md += markdownTable(data, tmpl.columns);
    }

    return md;
  };
}

function compileEntityProfile(tmpl: EntityProfileTemplate): (rows: Row[]) => string {
  return (rows) => {
    const data = tmpl.beforeRender ? tmpl.beforeRender(rows) : rows;
    const r = data[0];
    if (!r) return '';

    let md = DEFAULT_HEADER;

    // Frontmatter
    if (tmpl.frontmatter) {
      const fm = typeof tmpl.frontmatter === 'function' ? tmpl.frontmatter(r) : tmpl.frontmatter;
      md += frontmatter(fm);
    } else {
      md += frontmatter({});
    }

    // Heading
    const heading = typeof tmpl.heading === 'function' ? tmpl.heading(r) : tmpl.heading;
    md += `# ${heading}\n\n`;

    // Fields
    for (const field of tmpl.fields) {
      const val = r[field.key];
      if (val === null || val === undefined) continue;
      const formatted = field.format ? field.format(val, r) : String(val);
      if (formatted) {
        md += `**${field.label}:** ${formatted}\n`;
      }
    }

    // Enriched sections
    if (tmpl.sections) {
      for (const section of tmpl.sections) {
        const rawJson = r[`_${section.key}`] as string | undefined;
        if (!rawJson) continue;

        if (section.condition && !section.condition(r)) continue;

        const items = JSON.parse(rawJson) as Row[];
        if (items.length === 0) continue;

        const sectionHeading = typeof section.heading === 'function'
          ? section.heading(r) : section.heading;
        md += `\n## ${sectionHeading}\n\n`;

        if (section.render === 'table' && section.columns) {
          md += markdownTable(items, section.columns);
        } else if (section.render === 'list' && section.formatItem) {
          for (const item of items) {
            md += `- ${section.formatItem(item)}\n`;
          }
        } else if (typeof section.render === 'function') {
          md += section.render(items);
        }
      }
    }

    return md;
  };
}

function compileEntitySections(tmpl: EntitySectionsTemplate): (rows: Row[]) => string {
  return (rows) => {
    const data = tmpl.beforeRender ? tmpl.beforeRender(rows) : rows;
    let md = DEFAULT_HEADER;
    md += frontmatter(tmpl.frontmatter ?? {});
    md += `# ${tmpl.heading}\n\n`;

    if (data.length === 0) {
      md += tmpl.emptyMessage ?? '*No data.*\n';
      return md;
    }

    for (const row of data) {
      md += `## ${tmpl.perRow.heading(row)}\n`;

      if (tmpl.perRow.metadata?.length) {
        const parts = tmpl.perRow.metadata
          .map(m => {
            const val = row[m.key];
            const formatted = m.format ? m.format(val) : String(val ?? '');
            return `**${m.label}:** ${formatted}`;
          })
          .filter(Boolean);
        if (parts.length > 0) {
          md += parts.join(' | ') + '\n';
        }
      }

      if (tmpl.perRow.body) {
        md += `\n${tmpl.perRow.body(row)}\n`;
      }

      md += '\n';
    }

    return md;
  };
}
