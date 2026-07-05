// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const displayConfigJs = `
  (function () {
    // ────────────────────────────────────────────────────────────
    // Display config — labels + icons. Anything missing falls back
    // to title-case of the table name and a generic dot.
    // ────────────────────────────────────────────────────────────
    var DISPLAY = {
      meetings:     { label: 'Meetings',     icon: '📅' },
      people:       { label: 'People',       icon: '👥' },
      messages:     { label: 'Messages',     icon: '✉️' },
      projects:     { label: 'Projects',     icon: '📦' },
      repositories: { label: 'Repositories', icon: '💿' },
      files:        { label: 'Files',        icon: '📄' },
      secrets:      { label: 'Secrets',      icon: '🔐' },
    };
    // Cards shown on the dashboard (Secrets is sidebar-only by design).
    var DASHBOARD_ORDER = ['meetings', 'people', 'messages', 'projects', 'repositories', 'files'];

    var FIELD_DISPLAY = {
      starts_at: 'Date+Time',
      sent_at:   'Sent',
      role:      'Role',
      url:       'URL',
      path:      'Path',
      kind:      'Kind',
    };

    // Generic fallback icon when the user hasn't set one and the entity
    // name isn't in the built-in DISPLAY map.
    var DEFAULT_ICON = '📋';

    var state = {
      entities: null,
      rowCache: {},
      iconOverrides: {},
      columnMeta: {},
      systemTables: [],
      preferences: { show_system_tables: false, analytics: true },
      // Server-resolved analytics consent (stored pref AND env opt-outs). Drives
      // window.LatticeGA. False until loaded → no tracking before consent is known.
      analyticsEffective: false,
      // Whether the GUI may "Open in Finder" (LATTICE_LOCAL_OPEN, default on).
      localOpen: true,
    };

    // Anonymous analytics passthrough — a no-op unless window.LatticeGA exists and
    // consent is on. Params are sanitized to coarse enums/bools/numbers by
    // LatticeGA.track (never table names, ids, queries, or PII).
    function gaTrack(name, params) {
      if (window.LatticeGA) window.LatticeGA.track(name, params || {});
    }
    // Coarse route TYPE from the hash — the prefix segment(s) ONLY, never the
    // table / row-id / db segments that follow (those would be identifying).
    // Fed to LatticeGA.pageView (which itself never sends the raw hash).
    function routeType(hash) {
      var h = String(hash || '#/');
      if (h === '#/' || h === '') return 'dashboard';
      var parts = h.replace(/^#/, '').split('/').filter(Boolean);
      var top = (parts[0] || 'other').toLowerCase();
      if (!/^[a-z0-9_-]+$/.test(top)) return 'other';
      if (top === 'settings') {
        var sub = (parts[1] || 'root').toLowerCase();
        return /^[a-z0-9_-]+$/.test(sub) ? 'settings_' + sub : 'settings_root';
      }
      if (top === 'fs' || top === 'objects' || top === 'system') return top;
      if (top === 'analytics') return 'analytics'; // coarse segment only — never the dashboard id
      return 'other';
    }

    function isSecretColumn(tableName, colName) {
      var t = state.columnMeta[tableName];
      return !!(t && t[colName] && t[colName].secret);
    }
    // Resolved one-line definition for a column / table (server merges the
    // operator-authored value with a built-in default). '' when none — callers
    // omit the tooltip attribute entirely so there's no empty hover box.
    function colDesc(tableName, colName) {
      var t = state.columnMeta[tableName];
      var m = t && t[colName];
      return (m && m.description) || '';
    }
    function tableDesc(tableName) {
      var m = state.iconOverrides[tableName];
      return (m && m.description) || '';
    }
    // A ready-to-concat title="…" attribute (escaped, leading space) or '' —
    // for definition tooltips. Empty input yields no attribute (no empty box).
    function titleAttr(text) {
      return text ? ' title="' + escapeHtml(text) + '"' : '';
    }
    var SECRET_MASK = '••••••••'; // ••••••••
    // An encrypted-at-rest value (native secrets etc.) is stored with an "enc:"
    // sentinel prefix (see framework/native-entities decrypt). It is never
    // plaintext, so the GUI must never render the raw ciphertext — mask it the
    // same way an operator-flagged secret column is masked.
    function looksEncrypted(v) {
      return typeof v === 'string' && v.slice(0, 4) === 'enc:';
    }

    function displayFor(name) {
      // Artifacts is a virtual object (files carrying an artifact_type), not a real
      // table — give it a stable label + icon.
      if (name === 'artifacts') return { label: 'Artifacts', icon: '🧩' };
      var override = state.iconOverrides[name];
      var base = DISPLAY[name];
      var icon = (override && override.icon) || (base && base.icon) || autoEmojiFor(name) || DEFAULT_ICON;
      var label = (base && base.label) || titleCase(name);
      return { label: label, icon: icon };
    }
    // Pick an apt emoji from an entity's NAME when the user hasn't set one and it
    // isn't in the built-in DISPLAY map. Keyword match against the de-underscored,
    // lower-cased name; returns null when nothing fits so displayFor falls back to
    // DEFAULT_ICON ("only if an emoji is apt"). Purely presentational — no persistence.
    var AUTO_EMOJI = [
      [/\\b(meetings?|calendar|events?|appointments?|schedule)\\b/, '📅'],
      [/\\b(people|person|contacts?|users?|members?|staff|teams?|customers?|clients?|leads?|attendees?)\\b/, '👥'],
      [/\\b(messages?|emails?|mail|inbox|chats?|conversations?|communications?|comms?)\\b/, '✉️'],
      [/\\b(projects?)\\b/, '🚀'],
      [/\\b(files?|documents?|docs?|attachments?)\\b/, '📄'],
      [/\\b(repos?|repositor(?:y|ies)|commits?|branches?)\\b/, '💿'],
      [/\\b(invoices?|payments?|billing|transactions?|expenses?|orders?|purchases?)\\b/, '🧾'],
      [/\\b(revenue|budgets?|salar(?:y|ies)|prices?|pricing|costs?|finances?|financial)\\b/, '💰'],
      [/\\b(companies|company|orgs?|organizations?|accounts?|businesses|business|vendors?|firms?|suppliers?)\\b/, '🏢'],
      [/\\b(tasks?|todos?|tickets?|issues?|jobs?|bugs?)\\b/, '✅'],
      [/\\b(policies|policy|insurance|claims?|coverage)\\b/, '🛡️'],
      [/\\b(secrets?|credentials?|keys?|tokens?|passwords?)\\b/, '🔐'],
      [/\\b(notes?|memos?)\\b/, '📝'],
      [/\\b(products?|items?|inventory|skus?)\\b/, '📦'],
      [/\\b(reports?|analytics|metrics?|stats?|dashboards?)\\b/, '📊'],
      [/\\b(contracts?|agreements?|legal|ndas?)\\b/, '📜'],
      [/\\b(certificates?|certs?|licen[cs]es?)\\b/, '🎓'],
      [/\\b(properties|property|buildings?|estate|addresses|address|locations?|places?)\\b/, '🏠'],
      [/\\b(agents?|bots?|assistants?)\\b/, '🤖'],
      [/\\b(aliases|alias|tags?|labels?|categor(?:y|ies)|types?)\\b/, '🏷️'],
    ];
    function autoEmojiFor(name) {
      var s = String(name || '').replace(/_/g, ' ').toLowerCase();
      for (var i = 0; i < AUTO_EMOJI.length; i++) {
        if (AUTO_EMOJI[i][0].test(s)) return AUTO_EMOJI[i][1];
      }
      return null;
    }
    function titleCase(s) {
      return s.replace(/_/g, ' ').replace(/\\b\\w/g, function (c) { return c.toUpperCase(); });
    }
    function fieldLabel(col) {
      return FIELD_DISPLAY[col] || titleCase(col);
    }

    function escapeHtml(v) {
      if (v == null) return '';
      return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Inline span rules (bold/italic, inline code, http/https/mailto links).
    // The caller HTML-escapes FIRST, so these run on neutralized text — no raw
    // HTML can survive. Shared by the document renderer (mdRender) below.
    function mdInline(s) {
      var BT = String.fromCharCode(96); // backtick (avoids escaping in this template)
      // Strip C0 control chars (keep tab) so input can't collide with the U+0001
      // placeholder sentinel below — a stray sentinel could otherwise duplicate
      // or blank a code span — or smuggle a control byte into an emitted href.
      s = s.replace(/[\\u0000-\\u0008\\u000b-\\u001f]/g, '');
      var stash = [];
      function park(html) { stash.push(html); return '\\u0001' + (stash.length - 1) + '\\u0001'; }
      function emph(x) {
        return x.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>').replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
      }
      // Inline code and links are PARKED before the emphasis pass so a '*' inside
      // a code span or a URL can never be eaten as <em>/<strong> (which used to
      // corrupt hrefs like ?q=a*b*c). Restored verbatim at the end.
      s = s.replace(new RegExp(BT + '([^' + BT + ']+)' + BT, 'g'), function (_, c) { return park('<code>' + c + '</code>'); });
      s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, function (_, t, u) {
        if (!/^(https?:|mailto:)/i.test(u)) return t;
        return park('<a href="' + u + '" target="_blank" rel="noopener">' + emph(t) + '</a>');
      });
      s = emph(s);
      // Restore parked spans. Loop so a code span nested in a link label (parked
      // inside another parked span) is also resolved; bounded + halts on no progress.
      while (/\\u0001\\d+\\u0001/.test(s)) {
        var before = s;
        s = s.replace(/\\u0001(\\d+)\\u0001/g, function (_, n) { return stash[n] != null ? stash[n] : ''; });
        if (s === before) break;
      }
      return s;
    }
    // Markdown → HTML for rendered file/document previews (markdown artifacts +
    // ingested text). Input is HTML-escaped FIRST, so every rule runs on
    // neutralized text — no raw HTML survives. Covers the GitHub-flavored subset
    // an assistant emits in a document: headings, bold/italic, inline + fenced
    // code, ordered + unordered lists, links, blockquotes, horizontal rules, and
    // GFM tables. (The chat rail keeps its own lighter renderer, mdToHtml below.)
    function mdRender(text) {
      var src = escapeHtml(text == null ? '' : String(text));
      // Normalize CRLF / lone CR so a trailing \\r can't defeat the line-anchored
      // block rules (CRLF-authored docs degraded headings/lists into paragraphs).
      var lines = src.replace(/\\r\\n?/g, '\\n').split('\\n');
      var FENCE = String.fromCharCode(96, 96, 96);
      var html = '', i = 0, listType = null;
      function closeList() { if (listType) { html += '</' + listType + '>'; listType = null; } }
      function lstrip(x) { return x.replace(/^\\s+/, ''); }
      function isHr(x) { return /^\\s*([-*_])\\1\\1+\\s*$/.test(x); }
      function isTableSep(x) { return /^\\s*\\|?\\s*:?-+:?\\s*(\\|\\s*:?-+:?\\s*)+\\|?\\s*$/.test(x); }
      function startsTable(idx) { return idx + 1 < lines.length && lines[idx].indexOf('|') >= 0 && isTableSep(lines[idx + 1]); }
      function cells(row) { return row.trim().replace(/^\\|/, '').replace(/\\|$/, '').split('|').map(function (c) { return mdInline(c.trim()); }); }
      function blockAt(idx) {
        var x = lines[idx];
        return /^\\s*$/.test(x) || lstrip(x).indexOf(FENCE) === 0 || /^(#{1,6})\\s+/.test(x) ||
          /^\\s*[-*+]\\s+/.test(x) || /^\\s*\\d+\\.\\s+/.test(x) || /^\\s*&gt;\\s?/.test(x) || isHr(x) || startsTable(idx);
      }
      while (i < lines.length) {
        var line = lines[i];
        if (lstrip(line).indexOf(FENCE) === 0) {
          closeList(); var code = []; i++;
          while (i < lines.length && lstrip(lines[i]).indexOf(FENCE) !== 0) { code.push(lines[i]); i++; }
          i++;
          html += '<pre><code>' + code.join('\\n') + '</code></pre>';
          continue;
        }
        if (startsTable(i)) {
          closeList();
          html += '<table><thead><tr>';
          cells(line).forEach(function (c) { html += '<th>' + c + '</th>'; });
          html += '</tr></thead><tbody>';
          i += 2;
          while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim() !== '') {
            html += '<tr>';
            cells(lines[i]).forEach(function (c) { html += '<td>' + c + '</td>'; });
            html += '</tr>'; i++;
          }
          html += '</tbody></table>';
          continue;
        }
        var h = line.match(/^(#{1,6})\\s+(.*)$/);
        if (h) { closeList(); var tag = 'h' + Math.max(3, Math.min(6, h[1].length + 2)); html += '<' + tag + '>' + mdInline(h[2]) + '</' + tag + '>'; i++; continue; }
        if (isHr(line)) { closeList(); html += '<hr>'; i++; continue; }
        if (/^\\s*&gt;\\s?/.test(line)) {
          closeList(); var quote = [];
          while (i < lines.length && /^\\s*&gt;\\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\\s*&gt;\\s?/, '')); i++; }
          html += '<blockquote>' + mdInline(quote.join('<br>')) + '</blockquote>';
          continue;
        }
        var ul = line.match(/^\\s*[-*+]\\s+(.*)$/);
        if (ul) { if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; } html += '<li>' + mdInline(ul[1]) + '</li>'; i++; continue; }
        var ol = line.match(/^\\s*\\d+\\.\\s+(.*)$/);
        if (ol) { if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; } html += '<li>' + mdInline(ol[1]) + '</li>'; i++; continue; }
        if (/^\\s*$/.test(line)) { closeList(); i++; continue; }
        closeList();
        var para = [line]; i++;
        while (i < lines.length && !blockAt(i)) { para.push(lines[i]); i++; }
        html += '<p>' + mdInline(para.join('<br>')) + '</p>';
      }
      closeList();
      return html;
    }

    function truncate(s, n) {
      if (s == null) return '';
      s = String(s);
      return s.length > n ? s.slice(0, n) + '…' : s;
    }

    // DISPLAY predicate — mirror of isHiddenLinkTable in src/gui/data.ts. Hides
    // pure link tables from object lists / sidebars / graph nodes / the Markdown +
    // Tables panels. Catches BOTH a relation-declared junction (exactly 2 belongsTo,
    // only FK / system / name columns) AND a *physical* link table created without
    // declared relations — an AI-built files_<entity> shaped (id, name, x_id, y_id).
    // A display-only "name" label doesn't make a link table a first-class object.
    // Used ONLY for hiding from display/nav — never for deletion. Keep in lockstep.
    function isJunction(table) {
      var cols = table.columns || [];
      var sys = { id: 1, created_at: 1, updated_at: 1, deleted_at: 1, name: 1 };
      var rels = Object.values(table.relations || {});
      if (rels.length === 2 && rels.every(function (r) { return r.type === 'belongsTo'; })) {
        var fk = {};
        rels.forEach(function (r) { fk[r.foreignKey] = 1; });
        if (cols.every(function (c) { return fk[c] || sys[c]; })) return true;
      }
      // Physical link table (no / non-2 declared relations): exactly two *_id columns.
      var payload = cols.filter(function (c) { return !sys[c]; });
      return payload.length === 2 && payload.every(function (c) { return /_id$/.test(c); });
    }

    function tableByName(name) {
      return state.entities.tables.find(function (t) { return t.name === name; });
    }

    function fetchJson(url, opts) {
      return fetch(url, opts).then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || r.statusText); });
        return r.json();
      });
    }

    // Disable a button + show an inline spinner for the duration of an
    // async action so a slow server round-trip can't be double-clicked.
    // The fn arg should return a Promise; the button is restored on settle.
    function withBusy(btn, fn) {
      if (!btn || btn.disabled) return undefined;
      var original = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add('is-busy');
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + original;
      var restore = function () {
        btn.disabled = false;
        btn.classList.remove('is-busy');
        btn.innerHTML = original;
      };
      var result;
      try {
        result = fn();
      } catch (e) {
        restore();
        throw e;
      }
      if (result && typeof result.then === 'function') {
        return result.then(
          function (v) { restore(); return v; },
          function (e) { restore(); throw e; },
        );
      }
      restore();
      return result;
    }

`;
