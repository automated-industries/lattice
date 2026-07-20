// Auto-composed segment of the GUI client script. Verbatim substring of the original
// appJs template literal — do not hand-edit; see modules/index.ts for composition.
export const rowContextJs = `    // ────────────────────────────────────────────────────────────
    // Zero-workspace "virgin" state + onboarding wizard (Feature B).
    // Shown on first launch and after deleting the last workspace. A
    // full-screen welcome over the (empty) app chrome, with Create / Join
    // entry points that drive the existing workspace + onboarding APIs.
    // ────────────────────────────────────────────────────────────
    var BRAND_SVG =
      '<svg class="brand-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<rect x="0.5" y="0.5" width="23" height="23" rx="5" fill="#eff6ff" stroke="#dbeafe"/>' +
        '<g stroke="#3b82f6" stroke-width="1.25" stroke-linecap="round">' +
          '<line x1="6" y1="6" x2="18" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="6" y1="18" x2="18" y2="18"/>' +
          '<line x1="6" y1="6" x2="6" y2="18"/><line x1="12" y1="6" x2="12" y2="18"/><line x1="18" y1="6" x2="18" y2="18"/>' +
        '</g>' +
        '<g fill="#3b82f6">' +
          '<circle cx="6" cy="6" r="1.7"/><circle cx="12" cy="6" r="1.7"/><circle cx="18" cy="6" r="1.7"/>' +
          '<circle cx="6" cy="12" r="1.7"/><circle cx="12" cy="12" r="2.4"/><circle cx="18" cy="12" r="1.7"/>' +
          '<circle cx="6" cy="18" r="1.7"/><circle cx="12" cy="18" r="1.7"/><circle cx="18" cy="18" r="1.7"/>' +
        '</g>' +
      '</svg>';

    // Privacy indicators (lock = private, eye = shared) reused across the sidebar
    // object list and the entity detail header. Stroke currentColor so the caller
    // controls the tint (faint gray in the sidebar, inline in the detail line).
    var LOCK_SVG =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
    var EYE_SVG =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
    // A custom row with zero grantees is effectively PRIVATE (RLS shows it only to
    // the owner), so it must read as private, not "Shared with specific people
    // (0)". Only collapse for the OWNER's own view, where the grantees list is
    // authoritative — a member viewing a row shared WITH them gets custom with no
    // grantees list and must still read as "Shared with you".
    function effectiveVisibility(access) {
      if (!access || !access.visibility) return 'private';
      if (access.visibility === 'custom' && access.ownedByMe &&
        (!access.grantees || access.grantees.length === 0)) {
        return 'private';
      }
      return access.visibility;
    }
    // Owner-facing status label for a row's sharing, honoring effectiveVisibility
    // (so custom-0 reads as "Private to you") and appending the grantee count only
    // for a genuine specific-people share.
    function visInfoLabel(access) {
      var v = effectiveVisibility(access);
      var map = { everyone: 'Visible to everyone', private: 'Private to you', custom: 'Shared with specific people' };
      var s = map[v] || '';
      if (v === 'custom' && access && access.grantees) s += ' (' + access.grantees.length + ')';
      return s;
    }
    // Shared per-row lock/eye indicator, reused on the entity-detail header and the
    // fs card tiles so the meaning is consistent. The access arg is the server-
    // attached row._access (visibility + ownedByMe); returns empty when absent (a
    // local / non-cloud workspace has no sharing), so callers append it freely.
    // A hover tooltip spells out what the lock/eye means (state + ownership aware).
    function visIndicator(access, extraClass) {
      if (!access || !access.visibility) return '';
      var vis = effectiveVisibility(access);
      var tip = vis === 'private'
        ? 'Private — only you can see this'
        : vis === 'custom'
          ? (access.ownedByMe ? 'Shared with specific people' : 'Shared with you')
          : 'Shared — visible to everyone';
      return '<span class="vis-indicator' + (vis === 'private' ? ' is-private' : '') +
        (extraClass ? ' ' + extraClass : '') + '" title="' + escapeHtml(tip) + '">' +
        (vis === 'private' ? LOCK_SVG : EYE_SVG) + '</span>';
    }
    // Sidebar object-list indicator: lock when the table's new rows default to
    // private, eye when shared with everyone. Only the cloud owner gets the
    // per-table policy (server gates it), so on local/member it renders nothing.
    function navVisIcon(t) {
      if (!t || t.defaultRowVisibility === undefined) return '';
      return t.shared
        ? '<span class="nav-vis" title="Shared with everyone">' + EYE_SVG + '</span>'
        : '<span class="nav-vis" title="Private by default">' + LOCK_SVG + '</span>';
    }

    function renderVirginState() {
      var existing = document.getElementById('virgin-state');
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      var el = document.createElement('div');
      el.id = 'virgin-state';
      el.className = 'virgin-state';
      el.innerHTML =
        '<div class="virgin-card">' +
          BRAND_SVG +
          '<h1>Welcome to Lattice</h1>' +
          '<p>Create a workspace to get started, or join one you were invited to.</p>' +
          '<div class="virgin-actions">' +
            '<button class="btn primary" id="virgin-create">Create a workspace</button>' +
            '<button class="btn" id="virgin-join">Join via invite</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(el);
      el.querySelector('#virgin-create').addEventListener('click', function () { showOnboardingWizard('create'); });
      el.querySelector('#virgin-join').addEventListener('click', function () { showOnboardingWizard('join'); });
    }

    // Multi-step onboarding modal. mode 'create' | 'join'. Identity-first, with
    // Back navigation. Drives the existing APIs: identity → create-local /
    // create-local-then-migrate (cloud) / redeem-invite (join). On success the
    // server has switched into the new workspace, so a reload re-runs init() into
    // the normal layout.
    function showOnboardingWizard(mode) {
      var st = { step: 'identity', name: '', email: '', wsName: '', kind: 'local' };
      var backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      document.body.appendChild(backdrop);
      function close() { if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop); }

      // Prefill identity. The Claude connection is enforced globally by the boot
      // connect wall (before any workspace loads), so this wizard no longer has a
      // connect step — by the time the user is here, the assistant is connected.
      fetchJson('/api/userconfig/identity').catch(function () { return null; }).then(function (id) {
        st.name = (id && id.display_name) || '';
        st.email = (id && id.email) || '';
        if (!st.wsName && st.name) st.wsName = st.name + "'s Workspace";
        render();
      });

      function field(label, id, type, value, placeholder) {
        return '<div class="u-mb-3"><label class="field-label">' + escapeHtml(label) + '</label>' +
          '<input type="' + type + '" id="' + id + '" value="' + escapeHtml(value || '') + '"' +
          (placeholder ? ' placeholder="' + escapeHtml(placeholder) + '"' : '') +
          ' autocapitalize="off" autocorrect="off" spellcheck="false" class="u-w-100"></div>';
      }

      function render() {
        var title = mode === 'join' ? 'Join a workspace' : 'Create a workspace';
        var body = '';
        var primary = 'Next';
        var showBack = st.step !== 'identity';
        if (st.step === 'identity') {
          body = '<p class="dialog-lead">First, who are you? This labels your edits and is reused if you join a team.</p>' +
            field('Your name', 'ob-name', 'text', st.name, 'Ada Lovelace') +
            field('Email', 'ob-email', 'email', st.email, 'you@example.com');
        } else if (st.step === 'kind') {
          body = '<p class="dialog-lead">A local workspace lives on this machine. A cloud workspace is a shared Postgres your team can join.</p>' +
            '<div class="u-row u-mb-3">' +
              '<label class="ob-kind"><input type="radio" name="ob-kind" value="local"' + (st.kind === 'local' ? ' checked' : '') + '> Local</label>' +
              '<label class="ob-kind"><input type="radio" name="ob-kind" value="cloud"' + (st.kind === 'cloud' ? ' checked' : '') + '> Cloud</label>' +
            '</div>' +
            field('Workspace name', 'ob-wsname', 'text', st.wsName, 'My Workspace');
          primary = st.kind === 'cloud' ? 'Next' : 'Create';
        } else if (st.step === 'cloud') {
          body = '<p class="dialog-lead">Enter a <strong>fresh, empty</strong> Postgres database. Lattice creates the workspace, installs row-level security, and makes you the owner.</p>' +
            postgresFormHtml({ label: slugifyName(st.wsName) });
          primary = 'Create cloud →';
        } else if (st.step === 'join') {
          body = '<p class="dialog-lead">Paste the invite token the workspace owner sent to <strong>' + escapeHtml(st.email || 'your email') + '</strong>.</p>' +
            field('Invite token', 'ob-token', 'text', '', 'paste token here');
          primary = 'Join';
        }
        backdrop.innerHTML =
          '<div class="modal">' +
            '<div class="modal-head">' + escapeHtml(title) + '</div>' +
            '<div class="modal-body">' + body + '<div id="ob-msg" class="hint u-mt-3"></div></div>' +
            '<div class="modal-foot">' +
              (showBack ? '<button class="btn" data-act="back">Back</button>' : '<button class="btn" data-act="cancel">Cancel</button>') +
              '<button class="btn primary" data-act="ok">' + escapeHtml(primary) + '</button>' +
            '</div>' +
          '</div>';
        backdrop.querySelector('[data-act="ok"]').addEventListener('click', onNext);
        var backBtn = backdrop.querySelector('[data-act="back"]');
        if (backBtn) backBtn.addEventListener('click', onBack);
        var cancelBtn = backdrop.querySelector('[data-act="cancel"]');
        if (cancelBtn) cancelBtn.addEventListener('click', close);
      }

      function onBack() {
        if (st.step === 'kind' || st.step === 'join') st.step = 'identity';
        else if (st.step === 'cloud') st.step = 'kind';
        render();
      }

      function setMsg(t) { var m = backdrop.querySelector('#ob-msg'); if (m) m.textContent = t; }

      function onNext() {
        var okBtn = backdrop.querySelector('[data-act="ok"]');
        if (st.step === 'identity') {
          st.name = (backdrop.querySelector('#ob-name').value || '').trim();
          st.email = (backdrop.querySelector('#ob-email').value || '').trim();
          if (!st.name) { setMsg('Please enter your name.'); return; }
          if (!st.wsName) st.wsName = st.name + "'s Workspace";
          withBusy(okBtn, function () {
            return fetch('/api/userconfig/identity', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ display_name: st.name, email: st.email }),
            }).then(function () {
              st.step = mode === 'join' ? 'join' : 'kind';
              render();
            }).catch(function (e) { setMsg('Failed: ' + e.message); });
          });
          return;
        }
        if (st.step === 'kind') {
          st.kind = (backdrop.querySelector('input[name="ob-kind"]:checked') || {}).value || 'local';
          st.wsName = (backdrop.querySelector('#ob-wsname').value || '').trim() || st.wsName;
          if (!st.wsName) { setMsg('Please name the workspace.'); return; }
          if (st.kind === 'cloud') { st.step = 'cloud'; render(); return; }
          // Local: create + reload into the new workspace.
          withBusy(okBtn, function () {
            setMsg('Creating…');
            return createWorkspaceAndReload(st.wsName);
          });
          return;
        }
        if (st.step === 'cloud') {
          var pg = readPostgresWizardForm();
          withBusy(okBtn, function () {
            setMsg('Creating local workspace…');
            // Create a local workspace first (gives the server an active DB), then
            // migrate it into the fresh cloud — the existing migrate path.
            return fetch('/api/workspaces/create', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: st.wsName }),
            }).then(function (r) { return r.json(); }).then(function (d) {
              if (d.error) throw new Error(d.error);
              setMsg('Migrating to cloud… (this may take a moment)');
              return fetch('/api/dbconfig/migrate-to-cloud', {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pg),
              }).then(function (r2) { return r2.json().then(function (b) { return { status: r2.status, body: b }; }); });
            }).then(function (r) {
              if (!r.body.ok) throw new Error(r.body.error || ('HTTP ' + r.status));
              finishOnboarding();
            }).catch(function (e) { setMsg('Failed: ' + e.message); });
          });
          return;
        }
        if (st.step === 'join') {
          var token = (backdrop.querySelector('#ob-token').value || '').trim();
          if (!token) { setMsg('Paste the invite token.'); return; }
          withBusy(okBtn, function () {
            setMsg('Joining…');
            return fetch('/api/cloud/redeem-invite', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ email: st.email, token: token }),
            }).then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
              .then(function (r) {
                if (!r.body.ok) throw new Error(r.body.error || ('HTTP ' + r.status));
                finishOnboarding();
              }).catch(function (e) { setMsg('Failed: ' + e.message); });
          });
          return;
        }
      }

      function createWorkspaceAndReload(name) {
        return fetch('/api/workspaces/create', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: name }),
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (d.error) throw new Error(d.error);
          finishOnboarding();
        }).catch(function (e) { setMsg('Failed: ' + e.message); });
      }

      function finishOnboarding() {
        // The server has switched into the new workspace; reload re-runs init()
        // into the normal layout (the virgin overlay + this modal go with it).
        close();
        location.reload();
      }
    }

    // Lowercase, space→dash slug for a default cloud credential label.
    function slugifyName(s) {
      return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    }

`;
