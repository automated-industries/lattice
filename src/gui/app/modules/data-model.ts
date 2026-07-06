// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const dataModelJs = `    // ────────────────────────────────────────────────────────────
    // Single-step Create Workspace dialog. Used from the header dropdown
    // "+ New workspace" button and from Lattice Settings → Add new workspace.
    // One step: name + kind (+ cloud credentials if cloud) → Create. Entities
    // are added later from the workspace itself — there is no pre-creation step.
    // ────────────────────────────────────────────────────────────
    function showCreateDatabaseWizard() {
      var wizState = {
        name: '',
        kind: 'local',
        // Canonical cloud connection input: the SAME structured Postgres fields
        // (postgresFormHtml) used by onboarding + "Migrate to cloud". Captured as
        // they are typed so they survive the re-render when the kind toggles. The
        // retired postgres:// URL input was the only divergent cloud-create
        // methodology; every cloud-create path now shares this form + the
        // migrate-to-cloud API.
        pg: { label: '', host: '', port: 5432, dbname: '', user: '', password: '' },
      };
      openWizard();

      function openWizard() {
        var backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.innerHTML =
          '<div class="modal" style="min-width:560px;max-width:640px">' +
            '<div class="modal-head" id="wiz-head">New workspace</div>' +
            '<div class="modal-body" id="wiz-body"></div>' +
            '<div class="modal-foot">' +
              '<button class="btn" data-act="cancel">Cancel</button>' +
              '<button class="btn primary" data-act="next">Create</button>' +
            '</div>' +
          '</div>';
        document.body.appendChild(backdrop);
        function close() { if (backdrop.parentNode) document.body.removeChild(backdrop); }
        backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
        backdrop.querySelector('[data-act="cancel"]').addEventListener('click', close);
        backdrop.querySelector('[data-act="next"]').addEventListener('click', goNext);
        render();

        function render() {
          var body = backdrop.querySelector('#wiz-body');
          var nextBtn = backdrop.querySelector('[data-act="next"]');
          // Join hands off to the invite-redeem modal; local/cloud create here.
          nextBtn.textContent = wizState.kind === 'join' ? 'Continue' : 'Create';
          body.innerHTML = renderStep1();
          wireStepHandlers(body);
        }

        function renderStep1() {
          var kind = wizState.kind;
          // Join uses the existing invite-redeem modal (opened on Next), so no
          // name/entities steps — the DB name comes from the team you join.
          var nameField = kind === 'join' ? '' :
            '<div class="field"><label>Workspace name</label>' +
              '<input id="wiz-name" type="text" value="' + escapeHtml(wizState.name) +
              '" placeholder="e.g. my-research, design-system" maxlength="200" />' +
            '</div>';
          var cloudBlock = '';
          if (kind === 'cloud') {
            // The SAME structured connection form used by onboarding + Migrate to
            // cloud. Lattice creates the workspace, installs row-level security,
            // and makes you the owner. (Password is never echoed back on a
            // re-render; it is retained in wizState.pg as you type.)
            cloudBlock =
              '<p style="font-size:11px;color:var(--text-muted);margin:8px 0 6px">' +
                'Enter a <strong>fresh, empty</strong> Postgres database. Lattice creates the ' +
                'workspace, installs row-level security, and makes you the owner.' +
              '</p>' +
              postgresFormHtml({
                label: wizState.pg.label || slugifyName(wizState.name),
                host: wizState.pg.host,
                port: wizState.pg.port,
                dbname: wizState.pg.dbname,
                user: wizState.pg.user,
              });
          } else if (kind === 'join') {
            cloudBlock = '<p style="font-size:12px;color:var(--text-muted);margin:4px 0 0">Click Next to paste your cloud URL and invite token.</p>';
          }
          return '' +
            nameField +
            '<div class="field"><label>Kind</label>' +
              '<div class="wiz-kind-opts">' +
                '<label class="wiz-kind-card">' +
                  '<input type="radio" name="wiz-kind" value="local"' + (kind === 'local' ? ' checked' : '') + ' />' +
                  '<span class="wiz-kind-name">New local <span class="wiz-kind-sub">SQLite</span></span>' +
                '</label>' +
                '<label class="wiz-kind-card">' +
                  '<input type="radio" name="wiz-kind" value="cloud"' + (kind === 'cloud' ? ' checked' : '') + ' />' +
                  '<span class="wiz-kind-name">New cloud <span class="wiz-kind-sub">Postgres</span></span>' +
                '</label>' +
                '<label class="wiz-kind-card">' +
                  '<input type="radio" name="wiz-kind" value="join"' + (kind === 'join' ? ' checked' : '') + ' />' +
                  '<span class="wiz-kind-name">Join a team <span class="wiz-kind-sub">invite</span></span>' +
                '</label>' +
              '</div>' +
              '<p style="font-size:11px;color:var(--text-muted);margin:6px 0 0">' +
                'Local workspaces are single-user SQLite files on your machine. Cloud workspaces are Postgres, can be shared with invited members, and stream realtime updates. Join a team you were invited to with an invite token.' +
              '</p>' +
            '</div>' +
            cloudBlock;
        }

        function wireStepHandlers(scope) {
          {
            var nameInput = scope.querySelector('#wiz-name');
            if (nameInput) nameInput.addEventListener('input', function (e) { wizState.name = e.target.value; });
            scope.querySelectorAll('input[name="wiz-kind"]').forEach(function (radio) {
              radio.addEventListener('change', function () {
                wizState.name = (scope.querySelector('#wiz-name') || {}).value || wizState.name;
                wizState.kind = radio.value;
                render(); // re-render to show/hide cloud fields
              });
            });
            // Capture the structured Postgres fields as they're typed, so they
            // survive the re-render when the kind toggles (the form DOM is
            // replaced) and are available at submit — including the password,
            // which postgresFormHtml never echoes back into the input on a re-render.
            var pgIds = {
              'w-label': 'label',
              'w-host': 'host',
              'w-port': 'port',
              'w-dbname': 'dbname',
              'w-user': 'user',
              'w-password': 'password',
            };
            Object.keys(pgIds).forEach(function (id) {
              var el = scope.querySelector('#' + id);
              if (!el) return;
              el.addEventListener('input', function () {
                var key = pgIds[id];
                wizState.pg[key] = key === 'port' ? Number(el.value) || 5432 : el.value;
              });
            });
          }
        }

        function goNext() {
          // Join a cloud: hand off to the join modal, which collects the scoped
          // connection credentials and connects directly as a member.
          if (wizState.kind === 'join') { close(); showJoinTeamModal('project'); return; }
          if (!wizState.name.trim()) { showToast('Workspace name is required'); return; }
          // The display name is free-form (special characters allowed). The server
          // stores it verbatim and derives a safe directory slug from it
          // (toSafeDirName) — so the only constraint here is a sane length.
          if (wizState.name.trim().length > 200) { showToast('Workspace name must be 200 characters or fewer'); return; }
          if (wizState.kind === 'cloud') {
            // A cloud is created by migrating this new workspace into a fresh
            // Postgres DB described by the structured connection fields.
            var pg = wizState.pg;
            if (!pg.host.trim() || !pg.dbname.trim() || !pg.user.trim() || !pg.password) {
              showToast('Host, database name, user, and password are required for a cloud workspace');
              return;
            }
          }
          submit();
        }

        function submit() {
          var nextBtn = backdrop.querySelector('[data-act="next"]');
          nextBtn.setAttribute('disabled', 'disabled');
          nextBtn.textContent = 'Creating…';
          var promise = wizState.kind === 'local' ? submitLocal() : submitCloud();
          promise.then(function () {
            close();
            return reloadEverything();
          }).then(function () {
            showToast('Workspace "' + wizState.name + '" created', {});
          }).catch(function (err) {
            nextBtn.removeAttribute('disabled');
            nextBtn.textContent = 'Create';
            showToast('Create failed: ' + (err && err.message ? err.message : String(err)));
          });
        }

        function submitLocal() {
          gaTrack('workspace_create', { kind: 'local' }); // coarse enum only, no name
          // Create + activate a new local workspace in the registry (the single
          // source of truth). The friendly name is the workspace display name —
          // no separate slug/config-file/rename dance.
          return fetchJson('/api/workspaces/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: wizState.name.trim() }),
          });
        }

        function submitCloud() {
          // "Create a cloud" = create a fresh local workspace, then migrate that
          // workspace into the Postgres database
          // (installs row-level security, you become owner). Rows are
          // private-by-default and shared per-row via the eye toggle. Uses the
          // SAME structured connection fields + /api/dbconfig/migrate-to-cloud
          // path as onboarding and "Migrate to cloud" — one methodology, no
          // postgres:// URL parsing.
          var pg = wizState.pg;
          var fields = {
            type: 'postgres',
            label: (pg.label || slugifyName(wizState.name) || 'cloud').trim(),
            host: pg.host.trim(),
            port: Number(pg.port) || 5432,
            dbname: pg.dbname.trim(),
            user: pg.user.trim(),
            password: pg.password,
          };
          gaTrack('workspace_create', { kind: 'cloud' }); // coarse enum only, no creds
          return fetchJson('/api/workspaces/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: wizState.name.trim() }),
          }).then(function () {
            // The new workspace is now active; migrate it into the cloud.
            return fetch('/api/dbconfig/migrate-to-cloud', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(fields),
            })
              .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
              .then(function (r) {
                if (!r.body.ok) throw new Error(r.body.error || ('HTTP ' + r.status));
              });
          });
        }

      }
    }

    function showJoinTeamModal(kind) {
      void kind;
      // Join a cloud with the email-bound invite token the owner sent you. The
      // token decrypts LOCALLY with your email to the same scoped credential —
      // the member UI never handles a postgres:// string. You then connect
      // directly with your own scoped role; the database (RLS) enforces access.
      var bodyHtml =
        '<p style="margin:0 0 12px;font-size:13px;color:var(--text-muted)">' +
          'Enter the email this invite was sent to and the invite token the cloud ' +
          'owner gave you.' +
        '</p>' +
        '<div class="field"><label>Email</label>' +
          '<input id="join-email" type="email" placeholder="you@example.com" autocapitalize="off" autocorrect="off" spellcheck="false" style="width:100%"></div>' +
        '<div class="field" style="margin-top:8px"><label>Invite token</label>' +
          '<textarea id="join-token" rows="4" placeholder="paste the invite token" autocapitalize="off" autocorrect="off" spellcheck="false" style="width:100%;resize:vertical;font-family:JetBrains Mono,monospace;font-size:12px"></textarea></div>' +
        '<div id="join-msg" style="margin-top:10px;font-size:12px;color:var(--text-muted)"></div>';
      showModal('Join a cloud', bodyHtml, {
        primaryLabel: 'Join',
        onSubmit: function (scope) {
          void scope;
          var emailEl = document.getElementById('join-email');
          var tokenEl = document.getElementById('join-token');
          var email = (emailEl && emailEl.value ? emailEl.value : '').trim();
          var token = (tokenEl && tokenEl.value ? tokenEl.value : '').trim();
          if (!email || !token) throw new Error('Enter your email and the invite token');
          var msg = document.getElementById('join-msg');
          if (msg) msg.textContent = 'Connecting…';
          return fetch('/api/cloud/redeem-invite', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: email, token: token }),
          })
            .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
            .then(function (r) {
              if (!r.body.ok) throw new Error(r.body.error || ('HTTP ' + r.status));
              return reloadEverything().then(function () {
                showToast('Joined "' + (r.body.label || 'cloud') + '"', {});
              });
            });
        },
      });
    }

    function renderUserConfig(content) {
      content.innerHTML =
        '<div class="teams-page">' +
          '<h2>User Settings</h2>' +
          '<div id="identity-host"><div class="placeholder" style="padding:18px">Loading identity…</div></div>' +
          '<div id="assistant-host"></div>' +
          '<div id="preferences-host"></div>' +
        '</div>';
      renderIdentityPanel(document.getElementById('identity-host'));
      renderAssistantPanel(document.getElementById('assistant-host'));
      renderPreferencesPanel(document.getElementById('preferences-host'));
      // Databases catalog lives on Lattice Settings; per-database cloud/team
      // config lives on Database Settings. User Settings is identity +
      // preferences only — every config option in exactly one place.
    }


    function renderAssistantPanel(host) {
      fetchJson('/api/assistant/config').then(function (cfg) {
        cfg = cfg || {};
        function rowHtml(idBase, label, has, placeholder) {
          return '<div style="margin-bottom:12px">' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
              '<strong style="font-size:13px">' + label + '</strong>' +
              '<span class="feed-source" style="background:' + (has ? 'var(--accent-soft)' : 'var(--surface-2)') +
                ';color:' + (has ? 'var(--accent)' : 'var(--text-muted)') + '">' + (has ? 'Set' : 'Not set') + '</span>' +
            '</div>' +
            '<div style="display:flex;gap:8px;align-items:center">' +
              // data-1p-ignore / data-lpignore: this is an API-token box, not a
              // login password — tell 1Password/LastPass/Bitwarden to leave it
              // alone so pasting a key doesn't trigger their warning/fill popups.
              '<input id="' + idBase + '-key" type="password" autocomplete="off" data-1p-ignore data-lpignore="true" placeholder="' +
                (has ? '••••••••••••' : placeholder) + '" style="flex:1;background:var(--surface-2)">' +
              '<button id="' + idBase + '-save" class="btn">Save</button>' +
              (has ? '<button id="' + idBase + '-clear" class="btn">Clear</button>' : '') +
            '</div>' +
          '</div>';
        }
        host.innerHTML =
          '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<h3 style="margin:0 0 10px">Assistant</h3>' +
            // Connect happens at the first-run wall and disconnect lives in the
            // top-bar account menu — neither is configured here anymore (Claude
            // access is OAuth-only). This panel keeps only the behavior knobs.
            '<p class="lead" style="margin:0 0 12px;font-size:12px;color:var(--text-muted)">' +
              'Claude is connected for the whole app. Use the account menu in the top bar to disconnect.' +
            '</p>' +
            '<div style="margin:6px 0 12px">' +
              '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' +
                '<strong style="font-size:13px">Inference aggressiveness</strong>' +
                '<span id="asst-aggr-val" style="font-size:12px;color:var(--text-muted)"></span>' +
              '</div>' +
              '<input id="asst-aggr" type="range" min="0" max="1" step="0.05" ' +
                'value="' + (typeof cfg.aggressiveness === 'number' ? cfg.aggressiveness : 0.5) + '" ' +
                'style="width:100%">' +
              '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted)">' +
                '<span>Conservative</span><span>Aggressive</span>' +
              '</div>' +
              '<p class="lead" style="margin:4px 0 0;font-size:12px;color:var(--text-muted)">' +
                'How eagerly the assistant adds, enriches, and links objects (and ' +
                'auto-creates link tables) when you drop in files. Higher extrapolates more.' +
              '</p>' +
            '</div>' +
            '<div id="assistant-msg" style="margin-top:4px;font-size:12px;color:var(--text-muted)"></div>' +
          '</div>';
        var msg = host.querySelector('#assistant-msg');
        // Connect/disconnect + API-key configuration are gone from this panel
        // (Claude access is OAuth-only): connect is the first-run wall and
        // disconnect is the header account menu. Only the behavior knobs remain.
        var aggr = host.querySelector('#asst-aggr');
        var aggrVal = host.querySelector('#asst-aggr-val');
        function aggrLabel(v) {
          if (v <= 0.25) return 'Conservative (' + v.toFixed(2) + ')';
          if (v >= 0.75) return 'Aggressive (' + v.toFixed(2) + ')';
          return 'Balanced (' + v.toFixed(2) + ')';
        }
        if (aggr) {
          if (aggrVal) aggrVal.textContent = aggrLabel(parseFloat(aggr.value));
          aggr.addEventListener('input', function () {
            if (aggrVal) aggrVal.textContent = aggrLabel(parseFloat(aggr.value));
          });
          aggr.addEventListener('change', function () {
            msg.textContent = 'Saving…';
            fetch('/api/assistant/aggressiveness', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ value: parseFloat(aggr.value) }),
            })
              .then(function (r) { if (!r.ok) throw new Error('save failed (' + r.status + ')'); return r.json(); })
              .then(function () { msg.textContent = 'Saved.'; })
              .catch(function (e) { msg.textContent = 'Failed: ' + e.message; });
          });
        }
      }).catch(function (e) {
        host.innerHTML = '<div class="dbconfig-panel" style="padding:14px;border:1px solid var(--border);border-radius:8px">' +
          '<h3 style="margin:0 0 10px">Assistant</h3><div style="font-size:12px;color:var(--warn)">Could not load: ' +
          escapeHtml(e.message) + '</div></div>';
      });
    }

    function renderPreferencesPanel(host) {
      var prefs = state.preferences || { show_system_tables: false, analytics: false };
      host.innerHTML =
        '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
          '<h3 style="margin:0 0 10px">Preferences</h3>' +
          '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
            '<input type="checkbox" id="pref-analytics"' +
              (prefs.analytics === true ? ' checked' : '') + '>' +
            '<span>Send anonymous analytics</span>' +
          '</label>' +
          '<p class="lead" style="margin:8px 0 0;font-size:12px;color:var(--text-muted)">' +
            'Anonymous usage analytics — via ' +
            '<a href="https://scarf.sh" target="_blank" rel="noopener">Scarf</a> for installs and ' +
            'Google Analytics inside the app — help us improve Lattice. No table or column names, ' +
            'row data, queries, file names, or personal info are ever sent: only coarse, anonymized ' +
            'events. Respects Do-Not-Track.' +
          '</p>' +
          '<div id="pref-msg" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>' +
        '</div>';
      var msg = host.querySelector('#pref-msg');
      function savePref(body, after) {
        msg.textContent = 'Saving…';
        fetch('/api/userconfig/preferences', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (r) { return r.json(); })
          .then(function (next) {
            state.preferences = next;
            if (after) after();
            msg.textContent = 'Saved.';
          })
          .catch(function (e) { msg.textContent = 'Failed: ' + e.message; });
      }
      host.querySelector('#pref-analytics').addEventListener('change', function (e) {
        var on = !!e.target.checked;
        // Apply browser-analytics consent immediately. Record the opt-in AFTER
        // enabling (track needs consent) and the opt-out BEFORE disabling.
        if (on) {
          if (window.LatticeGA) window.LatticeGA.setConsent(true);
          gaTrack('analytics_opt_in', {});
        } else {
          gaTrack('analytics_opt_out', {});
          if (window.LatticeGA) window.LatticeGA.setConsent(false);
        }
        state.analyticsEffective = on;
        savePref({ analytics: on });
      });
    }

    function renderIdentityPanel(host) {
      fetchJson('/api/userconfig/identity').then(function (id) {
        host.innerHTML =
          '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<h3 style="margin:0 0 10px">Identity</h3>' +
            '<p class="lead" style="margin:0 0 10px">Display name + email used when creating or joining cloud workspaces. Saved to ~/.lattice/identity.json and mirrored into the active Lattice.</p>' +
            '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">' +
              '<div><label class="field-label">Display name</label><input id="id-display-name" type="text" value="' + escapeHtml(id.display_name || '') + '" style="width:100%"></div>' +
              '<div><label class="field-label">Email</label><input id="id-email" type="email" value="' + escapeHtml(id.email || '') + '" style="width:100%"></div>' +
            '</div>' +
            '<div class="team-actions" style="margin-top:10px">' +
              '<button class="btn primary" data-act="id-save">Save</button>' +
            '</div>' +
            '<div id="id-msg" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>' +
          '</div>';
        host.querySelector('[data-act="id-save"]').addEventListener('click', function () {
          var body = {
            display_name: document.getElementById('id-display-name').value || '',
            email: document.getElementById('id-email').value || '',
          };
          var msg = document.getElementById('id-msg');
          msg.textContent = 'Saving…';
          fetch('/api/userconfig/identity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json(); })
            .then(function () { msg.textContent = 'Saved.'; })
            .catch(function (e) { msg.textContent = 'Failed: ' + e.message; });
        });
      }).catch(function (err) {
        host.innerHTML = '<div class="placeholder">Failed to load identity: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function renderProjectConfig(content) {
      // Legacy entry — Track 4e renames this view to "Database Settings"
      // and adds an editable name header. The new alias is renderDatabaseSettings.
      renderDatabaseSettings(content);
    }

    function renderDatabaseSettings(content) {
      // Frame the page; the name header + Database + Teams panels each
      // populate asynchronously so a slow cloud probe doesn't block.
      // Active database only — name + connection/team config for THIS DB.
      // The all-databases list lives on Lattice Settings; adding/joining
      // databases lives in the add-database flow. Team management (invite
      // token + member list) for the active team cloud renders inline in the
      // Database panel below.
      content.innerHTML =
        '<div class="teams-page">' +
          '<h2>Workspace Settings</h2>' +
          '<div id="db-name-host"><div class="placeholder" style="padding:14px">Loading workspace name…</div></div>' +
          '<div id="dbconfig-host"><div class="placeholder" style="padding:18px">Loading database configuration…</div></div>' +
          // System Prompt subsection — directly beneath Database connection,
          // owner-only (the panel renders nothing for members / local).
          '<div id="system-prompt-host"></div>' +
          '<div id="data-model-host"><div class="placeholder" style="padding:18px">Loading data model…</div></div>' +
          '<div id="db-danger-host"></div>' +
        '</div>';
      renderDatabaseNamePanel(document.getElementById('db-name-host'));
      renderDatabasePanel(document.getElementById('dbconfig-host'));
      renderSystemPromptPanel(document.getElementById('system-prompt-host'));
      renderEntityEditorInto(document.getElementById('data-model-host'));
      renderDatabaseDangerZone(document.getElementById('db-danger-host'));
    }

    // Confirmation modal for the irreversible delete. Gated on typing the exact
    // database name; the OK button is solid red (destructive) and disabled until
    // the name matches. onDone(result) runs after a successful delete.
    function confirmDeleteDatabase(id, label, onDone) {
      var safeLabel = (label || '').trim() || 'this workspace';
      var body =
        '<p style="margin:0 0 10px">Permanently delete <strong>' + escapeHtml(safeLabel) + '</strong>? ' +
        'This removes it from this lattice and, for a local workspace, deletes the underlying SQLite file. ' +
        'For a cloud workspace only the local connection is forgotten — the remote data is left untouched. ' +
        '<strong style="color:var(--danger)">This cannot be undone.</strong></p>' +
        '<p style="margin:0 0 6px;font-size:12px;color:var(--text-muted)">Type <strong>' + escapeHtml(safeLabel) + '</strong> to confirm:</p>' +
        '<input id="confirm-db-name" type="text" autocomplete="off" style="width:100%" />';
      showModal('Delete workspace', body, {
        primaryLabel: 'Delete workspace',
        primaryClass: 'destructive',
        onBody: function (backdrop) {
          var input = backdrop.querySelector('#confirm-db-name');
          var ok = backdrop.querySelector('[data-act="ok"]');
          ok.disabled = true;
          input.addEventListener('input', function () {
            ok.disabled = (input.value || '').trim() !== safeLabel;
          });
          setTimeout(function () { input.focus(); }, 0);
        },
        onSubmit: function (backdrop) {
          var v = (backdrop.querySelector('#confirm-db-name').value || '').trim();
          if (v !== safeLabel) return Promise.reject(new Error('Type the workspace name exactly to confirm.'));
          return fetch('/api/workspaces/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: id }),
          })
            .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
            .then(function (res) {
              if (!res.d || res.d.error) throw new Error((res.d && res.d.error) || ('HTTP ' + res.status));
              if (onDone) return onDone(res.d);
            });
        },
      });
    }

    function renderDatabaseDangerZone(host) {
      if (!host) return;
      Promise.all([
        fetchJson('/api/workspaces'),
        fetchJson('/api/dbconfig').catch(function () { return {}; }),
      ]).then(function (results) {
        var data = results[0];
        var cfg = results[1] || {};
        var currentId = (data && data.current) || null;
        var workspaces = (data && data.workspaces) || [];
        var current = workspaces.filter(function (w) { return w.id === currentId; })[0] || {};
        var label = current.label || '';
        var id = current.id || '';
        if (!id) { host.innerHTML = ''; return; }

        // After tearing down / leaving the active workspace, switch to another
        // the operator still has and navigate off the (now-gone) page.
        var switchAway = function () {
          var target = workspaces.filter(function (w) { return w.id !== currentId; })[0];
          var p = target
            ? fetchJson('/api/workspaces/switch', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: target.id }),
              }).then(function () { return reloadEverything(); })
            : reloadEverything();
          return p.then(function () { location.hash = '#/analytics'; renderRoute(); });
        };

        if (cfg.state === 'cloud-owner' || cfg.state === 'cloud-member') {
          // v3: "leaving" a cloud just forgets the local connection and
          // switches this client back to another (local) workspace. It does
          // NOT mutate the cloud — the cloud keeps running for everyone else,
          // and there is no server-side registry to update.
          var cloudLabel = cfg.label || label || 'this cloud';
          host.innerHTML =
            '<div class="danger-zone">' +
              '<h3>Danger zone</h3>' +
              '<p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">' +
                'Forget this cloud connection on this device and switch back to a local workspace. ' +
                'The cloud keeps running for everyone else — this only affects your client.' +
              '</p>' +
              '<button class="btn destructive" id="db-forget-btn">Forget this cloud</button>' +
            '</div>';
          host.querySelector('#db-forget-btn').addEventListener('click', function () {
            if (!confirm('Forget "' + cloudLabel + '" on this device and switch back to a local workspace?')) return;
            var fbtn = host.querySelector('#db-forget-btn');
            withBusy(fbtn, function () {
              return switchAway()
                .then(function () { showToast('Forgot the cloud connection', {}); })
                .catch(function (e) { showToast('Failed: ' + e.message); });
            });
          });
          return;
        }
        // Local / non-team cloud workspace: delete it.
        host.innerHTML =
          '<div class="danger-zone">' +
            '<h3>Danger zone</h3>' +
            '<p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">' +
              'Permanently delete this workspace. It is removed from this lattice and, for a local workspace, the underlying SQLite file is deleted. This cannot be undone.' +
            '</p>' +
            '<button class="btn destructive" id="db-delete-btn">Delete workspace</button>' +
          '</div>';
        host.querySelector('#db-delete-btn').addEventListener('click', function () {
          confirmDeleteDatabase(id, label, function () {
            // We just deleted the active workspace; the server switched to a
            // fallback. Re-render the drawer's Workspace-settings tab so it
            // reflects the NEW active workspace — previously this rendered into
            // #content behind the open drawer, leaving the user stuck on the
            // deleted workspace's settings.
            return reloadEverything().then(function () {
              var drawer = document.getElementById('settings-drawer');
              if (drawer && !drawer.hidden) selectDrawerTab('database');
              else closeSettingsDrawer();
            });
          });
        });
      }).catch(function () { host.innerHTML = ''; });
    }

    function renderDatabaseNamePanel(host) {
      // Pull the friendly name from /api/workspaces and the cloud role from
      // /api/dbconfig (isOwner) so a non-owner member sees the name
      // read-only — renaming a cloud broadcasts to every member, so
      // only the owner may do it.
      Promise.all([fetchJson('/api/workspaces'), fetchJson('/api/dbconfig').catch(function () { return {}; })])
        .then(function (results) {
        var data = results[0];
        var cfg = results[1] || {};
        var currentId = (data && data.current) || null;
        var current = ((data && data.workspaces) || []).filter(function (w) { return w.id === currentId; })[0] || {};
        var name = current.label || '';
        var isCloud = current.kind === 'cloud';
        var kind = isCloud ? 'Cloud' : 'Local';
        // Members (cloud, non-owner) can't rename. Locals + owners can.
        var canRename = !isCloud || cfg.isOwner === true;
        // Logo subsection — cloud only (a local single-user workspace has no team to
        // brand for, and the cloud-settings store is a no-op on SQLite). Owner gets
        // upload + remove; a member sees the current logo read-only.
        function logoPreviewInner(etag) {
          return etag
            ? '<img src="/api/cloud/workspace-logo?v=' + encodeURIComponent(etag) + '" alt="Workspace logo" style="width:100%;height:100%;object-fit:contain">'
            : '<span style="font-size:10px;color:var(--text-muted);text-align:center;line-height:1.15">Default<br>mark</span>';
        }
        var logoSection = isCloud
          ? ('<div style="margin-top:16px;border-top:1px solid var(--border);padding-top:14px">' +
              '<div style="font-weight:600;margin-bottom:8px">Logo</div>' +
              '<div style="display:flex;align-items:center;gap:14px">' +
                '<div id="db-logo-preview" style="width:48px;height:48px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);display:flex;align-items:center;justify-content:center;overflow:hidden">' +
                  logoPreviewInner(cfg.logoEtag) +
                '</div>' +
                (cfg.isOwner
                  ? ('<div style="display:flex;flex-direction:column;gap:6px">' +
                      '<input type="file" id="db-logo-file" accept="image/png,image/jpeg" style="font-size:12px">' +
                      '<div style="display:flex;gap:8px">' +
                        '<button class="btn primary" id="db-logo-save">Save</button>' +
                        '<button class="btn" id="db-logo-remove"' + (cfg.logoEtag ? '' : ' disabled') + '>Remove</button>' +
                      '</div>' +
                    '</div>')
                  : '<span style="font-size:12px;color:var(--text-muted)">Set by the workspace owner.</span>') +
              '</div>' +
              '<div id="db-logo-msg" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>' +
              (cfg.isOwner
                ? '<p style="font-size:11px;color:var(--text-muted);margin:6px 0 0">Square PNG or JPEG, up to 64 KB. Replaces the Lattice mark in the topbar for every member.</p>'
                : '') +
            '</div>')
          : '';
        host.innerHTML =
          '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<h3 style="margin:0 0 10px">Display</h3>' +
            '<div style="display:flex;align-items:center;gap:8px">' +
              '<input id="db-name-input" type="text" value="' + escapeHtml(name) + '" maxlength="200" style="flex:1"' + (canRename ? '' : ' disabled') + ' />' +
              '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:' +
                (isCloud ? 'var(--accent-soft)' : 'rgba(15, 23, 42, 0.04)') +
                ';color:' + (isCloud ? 'var(--accent)' : 'var(--text-muted)') +
                ';text-transform:uppercase;letter-spacing:0.04em">' + kind + '</span>' +
              (canRename ? '<button class="btn primary" id="db-name-save">Save</button>' : '') +
            '</div>' +
            '<p style="font-size:11px;color:var(--text-muted);margin:6px 0 0">' +
              (canRename
                ? ('Friendly workspace name shown in the topbar and the dropdown. ' +
                  (isCloud
                    ? 'For cloud workspaces, the rename is broadcast to every member in realtime.'
                    : 'Saved to the workspace registry (and the config name: key).'))
                : 'Only the workspace owner can rename this cloud workspace.') +
            '</p>' +
            '<div id="db-name-msg" style="margin-top:6px;font-size:12px;color:var(--text-muted)"></div>' +
            logoSection +
          '</div>';
        // Logo upload / remove wiring (owner only; the controls don't render
        // otherwise). FileReader → data: URI → POST; the server validates square
        // PNG/JPEG and returns the new etag, which we use to refresh the preview
        // and swap the live topbar mark.
        var logoFileEl = host.querySelector('#db-logo-file');
        var logoSaveBtn = host.querySelector('#db-logo-save');
        var logoRemoveBtn = host.querySelector('#db-logo-remove');
        var logoMsg = host.querySelector('#db-logo-msg');
        var logoPreview = host.querySelector('#db-logo-preview');
        if (logoSaveBtn) logoSaveBtn.addEventListener('click', function () {
          var f = logoFileEl && logoFileEl.files && logoFileEl.files[0];
          if (!f) { logoMsg.textContent = 'Choose a PNG or JPEG first.'; return; }
          var reader = new FileReader();
          reader.onerror = function () { logoMsg.textContent = 'Could not read the file.'; };
          reader.onload = function () {
            withBusy(logoSaveBtn, function () {
              logoMsg.textContent = 'Uploading…';
              return fetch('/api/cloud/workspace-logo', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ logo: reader.result }),
              })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                  if (d.error) { logoMsg.textContent = 'Failed: ' + d.error; return; }
                  logoMsg.textContent = 'Saved.';
                  if (logoPreview) logoPreview.innerHTML = logoPreviewInner(d.logoEtag);
                  if (logoRemoveBtn) logoRemoveBtn.disabled = false;
                  applyWorkspaceLogo(d.logoEtag);
                })
                .catch(function (e) { logoMsg.textContent = 'Failed: ' + e.message; });
            });
          };
          reader.readAsDataURL(f);
        });
        if (logoRemoveBtn) logoRemoveBtn.addEventListener('click', function () {
          withBusy(logoRemoveBtn, function () {
            logoMsg.textContent = 'Removing…';
            return fetch('/api/cloud/workspace-logo', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ logo: '' }),
            })
              .then(function (r) { return r.json(); })
              .then(function (d) {
                if (d.error) { logoMsg.textContent = 'Failed: ' + d.error; return; }
                logoMsg.textContent = 'Removed.';
                if (logoPreview) logoPreview.innerHTML = logoPreviewInner(null);
                logoRemoveBtn.disabled = true;
                if (logoFileEl) logoFileEl.value = '';
                applyWorkspaceLogo(null);
              })
              .catch(function (e) { logoMsg.textContent = 'Failed: ' + e.message; });
          });
        });
        var saveBtn = host.querySelector('#db-name-save');
        if (saveBtn) saveBtn.addEventListener('click', function () {
          var v = (host.querySelector('#db-name-input').value || '').trim();
          var msg = host.querySelector('#db-name-msg');
          if (!v) { msg.textContent = 'Name cannot be empty.'; return; }
          withBusy(saveBtn, function () {
            msg.textContent = 'Saving…';
            return fetch('/api/dbconfig/rename', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: v }),
            })
              .then(function (r) { return r.json(); })
              .then(function (d) {
                if (d.error) { msg.textContent = 'Failed: ' + d.error; return; }
                msg.textContent = 'Saved.';
                // Refresh the topbar switcher so the new name shows.
                return fetchJson('/api/workspaces').then(renderWsSwitcher);
              })
              .catch(function (e) { msg.textContent = 'Failed: ' + e.message; });
          });
        });
      }).catch(function (err) {
        host.innerHTML = '<div class="placeholder">Failed to load workspace name: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function renderLatticeSettings(content) {
      content.innerHTML =
        '<div class="teams-page">' +
          '<h2>Lattice Settings</h2>' +
          '<p class="lead">Every workspace this lattice can switch to. This is the same list as the header dropdown.</p>' +
          '<div id="lattice-dbs-host"><div class="placeholder" style="padding:18px">Loading workspaces…</div></div>' +
        '</div>';
      var host = document.getElementById('lattice-dbs-host');
      // Single source of truth: the workspace registry (same as the header switcher).
      fetchJson('/api/workspaces').then(function (data) {
        var currentId = (data && data.current) || null;
        var workspaces = (data && data.workspaces) || [];
        var rows = workspaces.map(function (w) {
          var isActive = w.id === currentId;
          var kind = w.kind === 'cloud' ? 'Cloud (Postgres)' : 'Local (SQLite)';
          // Rows are click-to-switch; deletion lives in Workspace Settings → Danger Zone.
          // The active row is highlighted (.ws-active) and not click-to-switch.
          return '<tr class="' + (isActive ? 'ws-active' : 'ws-row') + '"' + (isActive ? '' : ' data-switch-id="' + escapeHtml(w.id) + '"') + '>' +
            '<td>' + escapeHtml(w.label) + (isActive ? ' <span class="role-tag">active</span>' : '') + '</td>' +
            '<td>' + kind + '</td>' +
            '<td><code>' + escapeHtml(w.dir || '') + '</code></td>' +
          '</tr>';
        }).join('');
        host.innerHTML =
          '<div class="dbconfig-panel" style="padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
              '<h3 style="margin:0">Workspaces</h3>' +
              '<button class="btn primary" id="action-add-db">+ Add new workspace</button>' +
            '</div>' +
            '<table style="width:100%;border-collapse:collapse">' +
              '<thead><tr style="text-align:left"><th>Name</th><th>Kind</th><th>Location</th></tr></thead>' +
              '<tbody>' + (rows || '<tr><td colspan="3" style="padding:8px;color:var(--text-muted)">No workspaces configured.</td></tr>') + '</tbody>' +
            '</table>' +
          '</div>';
        host.querySelectorAll('tr.ws-row[data-switch-id]').forEach(function (row) {
          row.addEventListener('click', function () {
            var id = row.getAttribute('data-switch-id');
            gaTrack('workspace_switch', {}); // event only — never the workspace id/name
            // Switch the workspace AND close the settings drawer at the same time —
            // close immediately (concurrent with the switch) so it isn't left open.
            closeSettingsDrawer();
            fetch('/api/workspaces/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id }) })
              .then(function (r) { return r.json(); })
              .then(function () { return reloadEverything(); })
              .catch(function (err) { showToast('Switch failed: ' + err.message, {}); });
          });
        });
        host.querySelector('#action-add-db').addEventListener('click', showCreateDatabaseWizard);
      }).catch(function (err) {
        host.innerHTML = '<div class="placeholder">Failed to load workspaces: ' + escapeHtml(err.message) + '</div>';
      });
    }

    // State-machine Database panel (v3). Renders a different body per
    // info.state: local -> Migrate to cloud; cloud-owner -> connection
    // summary + Invite a member; cloud-member -> connection summary + a
    // "you are a member" note. Security is enforced by the database (row-
    // level security) — there is no server-side member registry.
    function renderDatabasePanel(host) {
      fetchJson('/api/dbconfig').then(function (info) {
        var badge = renderStateBadge(info);
        var body = renderStateBody(info);
        host.innerHTML =
          '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">' +
              '<h3 style="margin:0">Database connection</h3>' +
              badge +
            '</div>' +
            body +
            '<div id="db-msg" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>' +
          '</div>';
        wireStateActions(host, info);
      }).catch(function (err) {
        host.innerHTML = '<div class="placeholder">Failed to load database config: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function renderStateBadge(info) {
      var label = '';
      var color = 'var(--text-muted)';
      switch (info.state) {
        case 'local':
          label = 'LOCAL';
          color = 'var(--text-muted)';
          break;
        case 'cloud-owner':
          label = '👑 CLOUD · OWNER';
          color = 'var(--accent)';
          break;
        case 'cloud-member':
          label = 'CLOUD · MEMBER';
          color = 'var(--accent)';
          break;
        default:
          label = String(info.state || 'UNKNOWN').toUpperCase();
      }
      return '<span style="font-family:JetBrains Mono,monospace;font-size:11px;letter-spacing:0.04em;padding:4px 10px;border-radius:999px;border:1px solid ' + color + ';color:' + color + '">' + escapeHtml(label) + '</span>';
    }

    function renderStateBody(info) {
      if (info.state === 'local') {
        return (
          '<p style="margin:0 0 12px;color:var(--text-muted);font-size:13px">' +
            'SQLite DB: <code>' + escapeHtml(info.dbFile || '(unknown)') + '</code>. ' +
            'Push this workspace to a cloud Postgres to collaborate. ' +
            '(To join a team, create a new workspace and choose “Join a team (invite)”.)' +
          '</p>' +
          '<div class="team-actions">' +
            '<button class="btn primary" data-act="open-migrate">Migrate to cloud →</button>' +
          '</div>'
        );
      }
      if (info.state === 'cloud-owner' || info.state === 'cloud-member') {
        var isOwner = info.isOwner === true;
        var cloudLabel = info.label || 'this cloud';
        return (
          renderConnectionSummary(info) +
          '<div style="margin-top:10px;font-size:13px">' +
            '<strong>Cloud:</strong> ' + escapeHtml(cloudLabel) +
            (isOwner ? ' · <span style="color:var(--accent)">owner</span>' : ' · <span style="color:var(--text-muted)">member</span>') +
          '</div>' +
          '<div class="team-actions" style="margin-top:10px">' +
            (isOwner ? '<button class="btn primary" data-act="open-invite">Invite a member</button>' : '') +
          '</div>' +
          // Owner: invite affordance below. Member: a short note. Row-level
          // security is enforced by the database, not this panel — there is
          // no server-side member registry to render.
          '<div id="db-members-host" style="margin-top:12px"></div>'
        );
      }
      return '<p style="color:var(--text-muted)">Unknown database state.</p>';
    }

    function renderConnectionSummary(info) {
      var parts = [];
      if (info.label) parts.push('<strong>Label:</strong> <code>' + escapeHtml(info.label) + '</code>');
      if (info.host) parts.push('<strong>Host:</strong> ' + escapeHtml(info.host) + ':' + (info.port || 5432));
      if (info.dbname) parts.push('<strong>DB:</strong> ' + escapeHtml(info.dbname));
      if (info.user) parts.push('<strong>User:</strong> ' + escapeHtml(info.user));
      return '<p style="margin:0;color:var(--text-muted);font-size:13px;line-height:1.7">' + parts.join(' · ') + '</p>';
    }

    function wireStateActions(host, info) {
      var setMsg = function (text, ok) {
        var el = document.getElementById('db-msg');
        if (!el) return;
        el.textContent = text;
        el.style.color = ok ? 'var(--accent)' : 'var(--text-muted)';
      };
      var rerender = function () { renderDatabasePanel(document.getElementById('dbconfig-host')); };

      var migrateBtn = host.querySelector('[data-act="open-migrate"]');
      if (migrateBtn) migrateBtn.addEventListener('click', function () {
        showMigrateToCloudModal(rerender);
      });

      // v3: there is NO server-side member registry. Security is enforced by
      // the database (row-level security); each member connects directly with
      // their own scoped Postgres role. The owner invites by provisioning a
      // scoped role and handing the credentials to the new member.
      var isOwner = info.isOwner === true;

      var inviteBtn = host.querySelector('[data-act="open-invite"]');
      if (inviteBtn) inviteBtn.addEventListener('click', function () {
        // Refresh the members list after a successful invite so the new invitee
        // appears ("Invited") without a manual reload.
        showInviteMemberModal(info, function () {
          if (typeof loadMembers === 'function') loadMembers();
        });
      });

      // Members list: the owner sees the owner + every member role; a member
      // sees a short note. Backed by /api/cloud/members (the lattice_members
      // group). The inline list itself is recovered from latticesql 1.14.0.
      var membersHost = host.querySelector('#db-members-host');
      if (membersHost) {
        if (info.state === 'cloud-member') {
          membersHost.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">You are a member of this cloud.</div>';
        } else {
          var loadMembers = function () {
            membersHost.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">Loading members…</div>';
            fetchJson('/api/cloud/members').then(function (data) {
              membersHost.innerHTML = renderMembersList((data && data.members) || [], isOwner);
              membersHost.querySelectorAll('[data-kick]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                  var role = btn.getAttribute('data-kick');
                  if (!role) return;
                  if (!window.confirm('Remove this member? They lose access immediately.')) return;
                  withBusy(btn, function () {
                    return fetchJson('/api/cloud/remove-member', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ role: role }),
                    }).then(function () {
                      showToast('Member removed', {});
                      loadMembers();
                    }).catch(function (e) {
                      showToast('Could not remove member: ' + (e && e.message ? e.message : e), {});
                    });
                  });
                });
              });
            }).catch(function (e) {
              membersHost.innerHTML = '<div style="font-size:12px;color:var(--warn)">Could not load members: ' + escapeHtml(e.message) + '</div>';
            });
          };
          loadMembers();
        }
      }
      void isOwner;
    }

    /** Members list (owner + member roles), recovered from latticesql 1.14.0
     *  (commit 2862959), adapted to the RLS-cloud member model. */
    function renderMembersList(members, canManage) {
      if (!members.length) {
        return '<div class="members-list"><h4>Members</h4>' +
          '<div style="font-size:12px;color:var(--text-muted)">Just you.</div></div>';
      }
      var rows = members.map(function (m) {
        var isOwner = m.status === 'owner';
        var pill = isOwner ? 'Owner' : (m.status === 'invited' ? 'Invited' : 'Member');
        // Show a human name (display name, else the email's local part, else the
        // role) + the email — NOT the bare Postgres role as the primary label.
        var label = (m.name && String(m.name).trim()) || m.role;
        var kick = canManage && !m.isYou && !isOwner
          ? '<button class="btn destructive" data-kick="' + escapeHtml(m.role) + '">Kick</button>'
          : '';
        return '<div class="member-row" data-role="' + escapeHtml(m.role) + '">' +
          '<span>' + escapeHtml(label) +
            (m.isYou ? ' <span style="color:var(--accent);font-size:11px">(you)</span>' : '') +
            (m.email ? ' <span style="color:var(--text-muted);font-size:11px">' + escapeHtml(m.email) + '</span>' : '') +
            ' <span class="role-tag' + (isOwner ? '' : ' role-member') + '">' + pill + '</span>' +
          '</span>' +
          kick +
        '</div>';
      }).join('');
      return '<div class="members-list"><h4>Members</h4>' + rows + '</div>';
    }

    // ── v1.13 wizards ─────────────────────────────────────────────

    function postgresFormHtml(prefill) {
      prefill = prefill || {};
      // autocapitalize="off" + autocorrect="off" + spellcheck="false" keep
      // mobile / macOS keyboards from "helpfully" capitalizing the first
      // letter of usernames + host fragments. Supabase tenant users
      // (postgres.<ref>) are case-sensitive and silently failed
      // authentication when iOS Safari turned the leading "p" into "P".
      var attrs = ' autocapitalize="off" autocorrect="off" spellcheck="false"';
      return (
        '<div class="grid" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">' +
          '<div><label class="field-label">Label</label><input type="text" id="w-label" placeholder="atlas" value="' + escapeHtml(prefill.label || '') + '" style="width:100%"' + attrs + '></div>' +
          '<div><label class="field-label">Host</label><input type="text" id="w-host" placeholder="db.example.com" value="' + escapeHtml(prefill.host || '') + '" style="width:100%"' + attrs + '></div>' +
          '<div><label class="field-label">Port</label><input type="number" id="w-port" placeholder="5432" value="' + escapeHtml(String(prefill.port || 5432)) + '" style="width:100%"></div>' +
          '<div><label class="field-label">Database name</label><input type="text" id="w-dbname" placeholder="app" value="' + escapeHtml(prefill.dbname || '') + '" style="width:100%"' + attrs + '></div>' +
          '<div><label class="field-label">User</label><input type="text" id="w-user" placeholder="lattice_user" value="' + escapeHtml(prefill.user || '') + '" style="width:100%"' + attrs + '></div>' +
          '<div><label class="field-label">Password</label><input type="password" id="w-password" placeholder="••••••••" style="width:100%"' + attrs + '></div>' +
        '</div>'
      );
    }

    function readPostgresWizardForm() {
      // Every text field is trimmed — pasted credentials frequently carry a
      // trailing newline or leading space that breaks URL construction
      // (zero-length identifier errors from the Postgres parser) or SCRAM
      // auth (silent password mismatch). Trim once, here, so every caller
      // benefits.
      var get = function (id) { return (document.getElementById(id).value || '').trim(); };
      return {
        type: 'postgres',
        label: get('w-label'),
        host: get('w-host'),
        port: Number(document.getElementById('w-port').value || 5432),
        dbname: get('w-dbname'),
        user: get('w-user'),
        password: get('w-password'),
      };
    }

    // Detect common Supabase pooler URL mistakes the form gives no hint
    // about. Returns an array of human-readable hints, or [] when the
    // form looks plausible. Conservative — only flags clear patterns.
    function detectSupabasePoolerMistakes(body) {
      var hints = [];
      var host = (body.host || '').toLowerCase();
      if (host.indexOf('pooler.supabase') !== -1) {
        // Pooler requires the tenant-prefixed user form postgres.<ref>.
        if (body.user && body.user.indexOf('.') === -1) {
          hints.push(
            'Supabase pooler hosts require a tenant-prefixed user like ' +
            '<code>postgres.&lt;project-ref&gt;</code>. You entered <code>' +
            escapeHtml(body.user) + '</code> — Supabase will reject SCRAM ' +
            'auth with a misleading "password authentication failed" error.'
          );
        }
        // Session-mode is on 5432; transaction-mode on 6543. latticesql
        // wants session-mode (transactions span multiple statements).
        if (Number(body.port) === 6543) {
          hints.push(
            'Supabase pooler port <code>6543</code> is transaction mode. ' +
            'Lattice needs session mode — use port <code>5432</code> on ' +
            'the same pooler host.'
          );
        }
      } else if (host.indexOf('.supabase.co') !== -1 && host.indexOf('pooler') === -1) {
        // Direct host form uses bare postgres user, not the tenant-
        // prefixed pooler form. Easy to mix up.
        if (body.user && body.user.indexOf('.') !== -1) {
          hints.push(
            'The direct host <code>db.&lt;project-ref&gt;.supabase.co</code> ' +
            'uses a bare <code>postgres</code> user (no tenant prefix). ' +
            'You entered <code>' + escapeHtml(body.user) + '</code> — ' +
            'Supabase will reject SCRAM auth with "password authentication ' +
            'failed".'
          );
        }
      }
      return hints;
    }

    // Probe the cloud and validate Supabase form patterns. Resolves to
    // the probe result on success; rejects with a human-readable error
    // when the form has obvious mistakes or the probe is unreachable.
    // Shared by Migrate + Connect so the credential is never saved
    // without first proving the form values can actually connect.
    function probeBeforeCredentialSave(body, msgEl) {
      var hints = detectSupabasePoolerMistakes(body);
      if (hints.length > 0) {
        // Block submit until the form is fixed. Show the hints inline.
        msgEl.innerHTML =
          '<strong style="color:var(--warn)">Connection looks wrong:</strong>' +
          '<ul style="margin:6px 0 0 18px;padding:0;color:var(--warn)">' +
          hints.map(function (h) { return '<li>' + h + '</li>'; }).join('') +
          '</ul>';
        return Promise.reject(new Error('Fix the issues above and try again.'));
      }
      msgEl.textContent = 'Testing connection…';
      return fetch('/api/dbconfig/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (r) { return r.json(); })
        .then(function (probe) {
          if (!probe.reachable) {
            throw new Error(
              'Cloud unreachable: ' + (probe.error || 'unknown error') +
              '. Double-check host, port, user, and password.'
            );
          }
          return probe;
        });
    }

    function showMigrateToCloudModal(onClose) {
      // v3: rows are private-by-default and shared per-row via the eye toggle,
      // not per-table at migrate time. Migrate copies the local SQLite into a
      // fresh Postgres, installs row-level security, and makes you the owner.
      var bodyHtml =
        '<p style="margin:0 0 12px;font-size:13px;color:var(--text-muted)">' +
          'Enter credentials for a <strong>fresh, empty</strong> Postgres database. ' +
          'Lattice will copy every row from your local SQLite into the new DB, ' +
          'install row-level security, make you the owner, then switch the project ' +
          'to read from the cloud. This action cannot be undone.' +
        '</p>' +
        postgresFormHtml({}) +
        '<div id="w-msg" style="margin-top:10px;font-size:12px;color:var(--text-muted)"></div>';
      showModal('Migrate to cloud', bodyHtml, {
        primaryLabel: 'Migrate →',
        onSubmit: function (scope) {
          void scope;
          var body = readPostgresWizardForm();
          var msg = document.getElementById('w-msg');
          // Validate Supabase URL pattern + probe the cloud before
          // persisting a credential that would just blow up on the next
          // open.
          return probeBeforeCredentialSave(body, msg).then(function (probe) {
            if (probe.isCloud) {
              throw new Error('That database is already a Lattice cloud — use Join instead.');
            }
            msg.textContent = 'Migrating… (this may take a moment for large DBs)';
            return fetch('/api/dbconfig/migrate-to-cloud', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
            })
              .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
              .then(function (r) {
                if (!r.body.ok) throw new Error(r.body.error || ('HTTP ' + r.status));
                // The active DB just swapped to the cloud server-side. Re-fetch +
                // re-render EVERYTHING (entities, rows with per-row _access sharing,
                // realtime) so the new state shows immediately — no manual refresh.
                // A panel-only rerender (the caller's onClose) left the rest of the
                // app showing stale pre-migrate data until the user reloaded.
                return reloadEverything().then(function () {
                  if (onClose) onClose();
                });
              });
          });
        },
      });
    }

    // Chat settings (drawer tab): the cloud chat system prompt, edited INLINE
    // with a Save button — no overlay. Owner-only (the GET returns the text only
    // to an owner); members / local workspaces see a short note instead.
    // The cloud chat System Prompt editor — a subsection of Settings → Workspace,
    // beneath Database connection. Owner-only: renders nothing for a member or a
    // local workspace (the GET reports supported=false / canEdit=false there), so
    // the subsection simply doesn't appear for them.
    function renderSystemPromptPanel(host) {
      if (!host) return;
      host.innerHTML = '';
      fetchJson('/api/cloud/system-prompt').then(function (cfg) {
        if (!cfg || cfg.supported !== true || cfg.canEdit !== true) return; // owner+cloud only
        var current = typeof cfg.prompt === 'string' ? cfg.prompt : '';
        host.innerHTML =
          '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<h3 style="margin:0 0 8px">System Prompt</h3>' +
            '<p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">' +
              'Added to every member chat in this cloud workspace. Members cannot see or edit it — only you, the owner, can.</p>' +
            '<textarea id="chat-system-prompt" rows="10" style="width:100%;font-family:inherit;resize:vertical" ' +
              'placeholder="e.g. Always answer in a formal tone. Our fiscal year starts in July.">' +
              escapeHtml(current) + '</textarea>' +
            '<div style="margin-top:10px;display:flex;align-items:center;gap:10px">' +
              '<button class="btn primary" id="chat-prompt-save">Save</button>' +
              '<span id="chat-prompt-msg" style="font-size:12px;color:var(--text-muted)"></span>' +
            '</div>' +
          '</div>';
        var saveBtn = document.getElementById('chat-prompt-save');
        var msg = document.getElementById('chat-prompt-msg');
        if (saveBtn) saveBtn.addEventListener('click', function () {
          var ta = document.getElementById('chat-system-prompt');
          var value = ta ? ta.value : '';
          if (msg) msg.textContent = 'Saving…';
          fetchJson('/api/cloud/system-prompt', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: value }),
          }).then(function () {
            if (msg) msg.textContent = 'Saved.';
          }).catch(function (e) {
            if (msg) msg.textContent = 'Failed: ' + (e && e.message ? e.message : String(e));
          });
        });
      }).catch(function () {
        // Not a cloud / not the owner / probe failed — leave the subsection empty.
      });
    }

    function showInviteMemberModal(info, onInvited) {
      // Owner-only invite: collect the invitee's email; the server provisions a
      // scoped role and returns ONE email-bound token carrying its credential.
      // The invitee redeems it with the same email in "Join a cloud" — no
      // postgres:// fields ever change hands. (Recovered from 1.14.0's email
      // invite flow, adapted to the RLS-cloud token.)
      info = info || {};
      var bodyHtml =
        '<div class="field"><label>Invitee email</label>' +
        '<input name="email" type="email" placeholder="bob@example.com" autocapitalize="off" autocorrect="off" spellcheck="false" /></div>' +
        '<p style="font-size:12px;color:var(--text-muted);margin:0">' +
        'The invite is bound to this email — only the recipient can redeem it.' +
        '</p>';
      showModal('Invite a member', bodyHtml, {
        primaryLabel: 'Generate invite',
        onSubmit: function (scope) {
          var data = collectFormValues(scope);
          if (!data.email) throw new Error('an invitee email is required');
          return fetchJson('/api/cloud/invite', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: data.email }),
          }).then(function (res) {
            gaTrack('member_invite', {}); // event only — never the invitee email
            showInviteTokenModal(res || {});
            if (typeof onInvited === 'function') onInvited();
          });
        },
      });
    }

    function showInviteTokenModal(res) {
      res = res || {};
      var token = res.token || '';
      var bodyHtml =
        '<p style="margin-top:0">Send this invite token to <code>' + escapeHtml(res.email || '') +
        '</code> (privately). They enter their email + this token in “Join a cloud”. It expires in ~7 days.</p>' +
        '<div class="copy-token" id="copy-invite" style="white-space:pre-wrap;word-break:break-all">' +
        escapeHtml(token) + '</div>' +
        '<p style="font-size:12px;color:var(--text-muted);margin-bottom:0">Click the token to copy.</p>';
      var handle = showModal('Invite token', bodyHtml, { primaryLabel: 'Done', onSubmit: function () {} });
      var blockEl = document.getElementById('copy-invite');
      if (blockEl) {
        blockEl.addEventListener('click', function () {
          navigator.clipboard.writeText(token).then(function () {
            var prev = blockEl.textContent;
            blockEl.textContent = 'Copied!';
            setTimeout(function () { blockEl.textContent = prev; }, 1200);
          });
        });
      }
      void handle;
    }


    // ============ AI assistant rail (2.0) ============
    var FEED_ICONS = {
      insert: '➕', update: '✏️', delete: '🗑',
      link: '🔗', unlink: '⛓', undo: '↶', redo: '↷', schema: '🛠',
    };
    // Schema mutations reach the client in two shapes: the LIVE feed publishes the
    // coarse op:'schema', while the persisted audit log / per-thread replay carry
    // the fine-grained op:'schema.delete_entity' (etc.). Treat both as schema so
    // they collapse + pick the 🛠 icon identically (regression: backfilled schema
    // ops showed '•' and never grouped).
    function isSchemaOp(op) { var o = String(op || ''); return o === 'schema' || o.indexOf('schema.') === 0; }
    function feedIcon(op) { return isSchemaOp(op) ? FEED_ICONS.schema : (FEED_ICONS[op] || '•'); }
    // Ops whose runs collapse into one counted bubble (bulk row work spams N
    // near-identical rows otherwise). Undo/redo stay distinct.
    var GROUPABLE_OPS = { insert: 1, update: 1, delete: 1, link: 1, unlink: 1 };
    var ROW_VERB = { insert: 'Added', update: 'Updated', delete: 'Removed', link: 'Linked', unlink: 'Unlinked' };
    var ROW_PREP = { insert: 'to', update: 'in', delete: 'from', link: 'in', unlink: 'in' };
    // Schema events all arrive as op:'schema'; the specific action lives only in
    // the summary text. Map that text to a stable sub-action so a bulk run of
    // "Deleted table X" collapses into one "Deleted 19 tables" pill. Each entry
    // is [verb, singular, plural].
    var SCHEMA_GROUP = {
      'created-table':  ['Created', 'table', 'tables'],
      'deleted-table':  ['Deleted', 'table', 'tables'],
      'renamed-table':  ['Renamed', 'table', 'tables'],
      'added-column':   ['Added', 'column', 'columns'],
      'renamed-column': ['Renamed', 'column', 'columns'],
      'added-link':     ['Added', 'link', 'links'],
      'deleted-link':   ['Deleted', 'link', 'links'],
      'created-link':   ['Created', 'link table', 'link tables'],
      'linked-rel':     ['Linked', 'relationship', 'relationships'],
    };
    function schemaAction(summary) {
      var s = String(summary || '');
      if (/^Created link table/.test(s)) return 'created-link';
      if (/^Created table/.test(s)) return 'created-table';
      if (/^Deleted table/.test(s)) return 'deleted-table';
      if (/^Renamed table/.test(s)) return 'renamed-table';
      // Two emitters: the generic "Added a column to X" and the specific
      // "Added column(s) a, b to X" (ingest auto-creates columns). Both group.
      if (/^Added (a )?column/.test(s)) return 'added-column';
      if (/^Renamed a column/.test(s)) return 'renamed-column';
      if (/^Added a link/.test(s)) return 'added-link';
      if (/^Deleted a link/.test(s)) return 'deleted-link';
      // Junction-materialization summaries ("Linked files ↔ project",
      // "Linked authors ↔ books") from materializeJunction — these arrive as a
      // schema op but matched no rule above, so they used to return null and
      // spam one ungrouped pill per link. Collapse a run into "Linked N
      // relationships".
      if (/^Linked .+ ↔ /.test(s)) return 'linked-rel';
      return null; // unknown schema op: keep it ungrouped (stay honest)
    }
    // Group identical-TYPE events into one counted pill regardless of which
    // object they touched, so a bulk run (delete N tables, remove rows across M
    // tables) shows a single bubble instead of overflowing the rail. Keyed by
    // op+source (+schema sub-action); the table is intentionally NOT in the key.
    // A group stays "open" for FEED_GROUP_WINDOW_MS after its last hit; later
    // activity starts a fresh bubble so unrelated edits aren't merged in.
    function feedGroupKey(ev) {
      var src = String(ev.source || '');
      if (isSchemaOp(ev.op)) {
        var a = schemaAction(ev.summary);
        return a ? 'schema|' + a + '|' + src : null;
      }
      return GROUPABLE_OPS[ev.op] ? String(ev.op) + '|' + src : null;
    }
    var feedGroups = {}; // key -> { op, count, tables, tableCount, schemaKey, firstSummary, item, summaryEl, timeEl, last, startMs, endMs, turnId }
    var FEED_GROUP_WINDOW_MS = 15000;
    // Assistant-turn scope for live activity-card grouping + duration. While a
    // turn is active, its same-type events all collapse into one card (no window
    // expiry); the card's timer measures from feedTurnStartMs to the last event.
    var feedTurnId = 0;
    var feedTurnActive = false;
    var feedTurnStartMs = 0;
    function onlyKey(obj) { for (var k in obj) { if (obj.hasOwnProperty(k)) return k; } return ''; }
    function groupedRowSummary(op, count, tables, tableCount) {
      var verb = ROW_VERB[op] || String(op || '');
      var noun = count === 1 ? 'row' : 'rows';
      var where = '';
      if (tableCount > 1) { where = ' across ' + tableCount + ' tables'; }
      else { var only = onlyKey(tables); if (only) where = ' ' + (ROW_PREP[op] || 'in') + ' ' + only; }
      return verb + ' ' + count + ' ' + noun + where;
    }
    function schemaGroupSummary(schemaKey, count, firstSummary) {
      var g = SCHEMA_GROUP[schemaKey];
      if (count <= 1 || !g) return firstSummary || '';
      return g[0] + ' ' + count + ' ' + g[2];
    }
    function groupedSummary(g) {
      return isSchemaOp(g.op)
        ? schemaGroupSummary(g.schemaKey, g.count, g.firstSummary)
        : groupedRowSummary(g.op, g.count, g.tables, g.tableCount);
    }
    // While a chat turn is streaming, its typing bubble (the not-yet-arrived next
    // assistant message) must stay last; tool-driven activity cards belong ABOVE
    // it, not below — otherwise the "typing…" dots land mid-conversation. Returns
    // the .chat-msg to insert before, or null when nothing is streaming.
    function feedTypingAnchor(feedEl) {
      var typing = feedEl.querySelector('.chat-bubble[data-typing="1"]');
      var msg = typing && typing.closest ? typing.closest('.chat-msg') : null;
      return (msg && msg.parentNode === feedEl) ? msg : null;
    }
    // Build one activity card (the shared full-width pill shape). Used by BOTH
    // the live feed and the per-thread replay so they look identical. Returns the
    // element plus the summary/time nodes a group mutates in place.
    function makeFeedCard(ev) {
      var item = document.createElement('div');
      item.className = 'feed-item';
      var icon = document.createElement('div');
      icon.className = 'feed-icon';
      icon.textContent = feedIcon(ev.op);
      var body = document.createElement('div');
      body.className = 'feed-body';
      var summary = document.createElement('div');
      summary.className = 'feed-summary';
      summary.textContent = ev.summary || (String(ev.op || '') + ' ' + String(ev.table || ''));
      var meta = document.createElement('div');
      meta.className = 'feed-meta';
      var src = document.createElement('span');
      src.className = 'feed-source';
      src.textContent = ev.source === 'gui' ? 'you' : String(ev.source || '');
      meta.appendChild(src);
      body.appendChild(summary);
      body.appendChild(meta);
      var time = document.createElement('div');
      time.className = 'feed-time';
      // Duration ("4s" / "4m 2s") is filled in by the caller once the group's
      // start/end span is known — not a relative "ago".
      time.textContent = '';
      item.appendChild(icon);
      item.appendChild(body);
      item.appendChild(time);
      // Row events (insert/update/delete) carry a rowId — make the card a
      // shortcut to that object. Link/unlink and schema events have no single
      // row (rowId is null), so they stay non-clickable.
      if (ev.rowId && ev.table) {
        item.classList.add('feed-clickable');
        item.setAttribute('role', 'button');
        item.setAttribute('tabindex', '0');
        item.title = 'Open this ' + String(ev.table);
        // _rowClickOff is set when the card becomes a group — clicks no-op then.
        var openRow = function () { if (item._rowClickOff) return; openSearchHit(String(ev.table), String(ev.rowId)); };
        item.addEventListener('click', openRow);
        item.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRow(); }
        });
      }
      return { item: item, summaryEl: summary, timeEl: time };
    }
    // Fold another event into an existing group card: bump the count, track the
    // table, refresh the summary, and drop the single-row affordances (a grouped
    // card stands for many rows, so it's a status, not a clickable button).
    // The card timer shows the TASK DURATION (start → finish), not a relative
    // "ago": for a single op it's the time that op took; for a grouped run it's
    // from the first task's start to the last task's finish. startMs is anchored
    // to the assistant turn's start (so a one-event card still shows real time);
    // endMs tracks the latest event in the group.
    function setGroupTime(g) {
      if (g.timeEl) g.timeEl.textContent = formatElapsed(Math.max(0, g.endMs - g.startMs));
    }
    function applyGroupHit(g, ev, endMs) {
      g.count += 1;
      if (ev.table && !g.tables[ev.table]) { g.tables[ev.table] = 1; g.tableCount += 1; }
      if (typeof endMs === 'number' && endMs > g.endMs) g.endMs = endMs;
      g.summaryEl.textContent = groupedSummary(g);
      setGroupTime(g);
      g.item._rowClickOff = true;
      g.item.classList.remove('feed-clickable');
      g.item.removeAttribute('tabindex');
      g.item.removeAttribute('title');
      g.item.setAttribute('role', 'status');
    }
    function newGroup(ev, card, startMs, endMs) {
      var tbls = {}; var tc = 0;
      if (ev.table) { tbls[ev.table] = 1; tc = 1; }
      return {
        op: ev.op, count: 1, tables: tbls, tableCount: tc,
        schemaKey: isSchemaOp(ev.op) ? schemaAction(ev.summary) : null,
        firstSummary: ev.summary || '',
        item: card.item, summaryEl: card.summaryEl, timeEl: card.timeEl,
        startMs: startMs, endMs: endMs,
      };
    }
    function renderFeedItem(ev) {
      // Realtime activity surfaces two ways: a transient TOP-RIGHT status that
      // flashes as it happens, and a persistent entry in the header activity feed
      // (the popover next to the version-history clock). The live brain-graph
      // animation still shows ingests landing on the graph.
      if (ev && ev.summary && typeof setStatus === 'function') {
        setStatus({ id: 'activity', kind: 'accent', text: ev.summary, priority: 30, sticky: false, ttl: 4500 });
      }
      if (ev && (ev.summary || ev.op) && typeof activityFeedEl === 'function') {
        var feed = activityFeedEl();
        if (feed) {
          var empty = document.getElementById('activity-empty');
          if (empty) empty.remove();
          var card = makeFeedCard(ev);
          // Single live event: stamp "now" (the duration form is for turn replay).
          card.timeEl.textContent = 'now';
          feed.insertBefore(card.item, feed.firstChild); // newest first
          while (feed.children.length > 50) feed.removeChild(feed.lastChild); // bounded log
          if (typeof bumpActivityCount === 'function') bumpActivityCount();
        }
      }
    }
    // Replay a persisted assistant turn's data-change events as collapsed activity
    // cards. Grouping is PER-TURN (self-contained, independent of the live feed's
    // rolling window) so each turn's bulk run shows one card and stays tied to the
    // turn that produced it. Reads aren't persisted as events, so only mutations
    // appear. Appends in order; the caller positions them after the turn's text.
    function renderTurnEventCards(feedEl, events, startedMs) {
      if (!feedEl || !events || !events.length) return;
      var groups = {};
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var evMs = ev.ts ? new Date(ev.ts).getTime() : startedMs;
        if (typeof evMs !== 'number' || isNaN(evMs)) evMs = startedMs;
        var startMs = (typeof startedMs === 'number' && !isNaN(startedMs)) ? startedMs : evMs;
        var key = feedGroupKey(ev);
        if (key && groups[key]) { applyGroupHit(groups[key], ev, evMs); continue; }
        var card = makeFeedCard(ev);
        feedEl.appendChild(card.item);
        if (key) { var g = newGroup(ev, card, startMs, evMs); groups[key] = g; setGroupTime(g); }
        else { card.timeEl.textContent = formatElapsed(Math.max(0, evMs - startMs)); }
      }
    }
    // Feed events arrive over the multiplexed /api/stream WebSocket and are
    // handled in dispatchStreamMessage('feed', …): renderFeedItem() paints the
    // card, then scheduleRealtimeRefresh() refetches on ANY data mutation (the
    // local feed bus delivers every insert/update/delete/link even with no
    // realtime broker, so this is what live-updates the dashboard counts and the
    // open entity view without a manual reload). The 200ms debounce coalesces a
    // burst into a single refetch and is shared with the realtime 'change' path.

`;
