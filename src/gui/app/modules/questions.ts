// Auto-composed segment of the GUI client script (see modules/index.ts). Must stay
// INSIDE the client IIFE (uses fetchJson + the analytics-view/onboarding helpers).
export const questionsJs = `
    // ────────────────────────────────────────────────────────────
    // Clarification questions — marginal automated inferences ask the user
    // instead of guessing. Pending questions (the server store) render as
    // interactive cards above the composer in the assistant dock (Analytics
    // view); the in-turn ask_user tool renders the same card inline in the
    // conversation. While ≥1 question is pending and the Analytics view is
    // not showing, the header's Ask trigger carries a notification dot; when
    // the user is idle a brand-new question switches to the Analytics view so
    // the cards are seen (both views stay mounted, so nothing is lost by the
    // flip). While the user is mid-edit (the computed-table builder) the view
    // is NOT switched — the question surfaces via the dot + a dismissible toast
    // so an in-progress build is never discarded.
    // ────────────────────────────────────────────────────────────
    var qCards = {};        // pending-store question id → card element
    var qPendingCount = 0;  // live pending count (drives the trigger dot)
    // Pending cards are collapsed behind a one-line banner by default: they are
    // workspace-scoped (a folder ingest can enqueue dozens), while the rail is
    // thread-scoped — expanding them all under whatever conversation is open
    // reads as one broken conversation. The banner keeps the count visible
    // without hijacking the thread; clicking it expands the stack in place.
    var qStackExpanded = false;
    function qContainer() { return document.getElementById('question-cards'); }
    // Lazily create the banner + collapsible stack inside the container. Cards
    // append into the stack (never the container root) so collapse is one hide.
    function qStack() {
      var host = qContainer();
      if (!host) return null;
      var stack = document.getElementById('q-stack');
      if (!stack) {
        stack = document.createElement('div');
        stack.id = 'q-stack';
        host.appendChild(stack);
      }
      return stack;
    }
    function qRenderBanner() {
      var host = qContainer();
      if (!host) return;
      // Look the stack up (don't create it) — at zero pending there may be
      // nothing to show, and an empty container keeps its :empty collapse.
      var stack = document.getElementById('q-stack');
      var banner = document.getElementById('q-banner');
      if (qPendingCount === 0) {
        // Nothing pending: no banner. Leave the stack visible so a just-answered
        // card's "✓" confirmation (it lingers briefly) isn't hidden mid-thanks.
        if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
        if (stack) stack.hidden = false;
        qStackExpanded = false;
        return;
      }
      if (!banner) {
        banner = document.createElement('button');
        banner.id = 'q-banner';
        banner.className = 'q-banner';
        banner.type = 'button';
        banner.setAttribute('aria-controls', 'q-stack');
        banner.addEventListener('click', function () {
          qStackExpanded = !qStackExpanded;
          qRenderBanner();
        });
        host.insertBefore(banner, host.firstChild);
      }
      banner.textContent = (qStackExpanded ? '▾ ' : '▸ ') + qPendingCount +
        (qPendingCount === 1 ? ' data question waiting' : ' data questions waiting') +
        (qStackExpanded ? '' : ' — review');
      banner.setAttribute('aria-expanded', qStackExpanded ? 'true' : 'false');
      if (stack) stack.hidden = !qStackExpanded;
    }
    // The dock is visible exactly when the Analytics view is — hash-derived so
    // the dot is correct no matter when it's evaluated relative to a re-render.
    function qDockShowing() { return isAnalyticsHash(location.hash); }
    function qShowDock() {
      location.hash = lastAnalyticsHash;
      var input = document.getElementById('chat-input');
      if (input) setTimeout(function () { input.focus(); }, 0);
    }
    function updateQuestionDot() {
      var trig = document.getElementById('ask-lattice-trigger');
      if (!trig) return;
      trig.classList.toggle('has-question', qPendingCount > 0 && !qDockShowing());
      // The dot is a CSS-only ::after — invisible to assistive tech — so also
      // reflect the pending count in the trigger's accessible name. Capture the
      // authored label once so it can be restored when nothing is pending.
      if (trig.__qBaseLabel == null) trig.__qBaseLabel = trig.getAttribute('aria-label') || 'Ask Lattice';
      trig.setAttribute('aria-label', qPendingCount > 0
        ? trig.__qBaseLabel + ' — ' + qPendingCount + (qPendingCount === 1 ? ' question waiting' : ' questions waiting')
        : trig.__qBaseLabel);
    }
    // A route/surface where the user is actively working, and where an
    // involuntary navigation would discard unsaved form state. Currently the
    // full-page computed-table builder (create + edit). A background question
    // must NOT yank the user out of these — it surfaces via the dot + a toast.
    function qUserIsEditing() {
      return (location.hash || '').indexOf('#/computed/') === 0;
    }
    // Non-destructive surface for a new question while the user is mid-edit:
    // a dismissible toast pointing at the assistant (the dot is already lit).
    function qNotifyNewQuestion() {
      if (typeof showToast === 'function') {
        showToast('New data question — see the Data Questions tab', {});
      }
    }
    // Announce a newly-arrived question to assistive tech (the dot + the dock
    // flip are both silent to screen readers). One polite live region, lazily
    // created and reused.
    function qAnnounce(msg) {
      var live = document.getElementById('q-live');
      if (!live) {
        live = document.createElement('div');
        live.id = 'q-live';
        live.setAttribute('aria-live', 'polite');
        live.setAttribute('role', 'status');
        live.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;padding:0;margin:-1px';
        document.body.appendChild(live);
      }
      live.textContent = msg;
    }
    // Build one interactive question card: the question text, one button per
    // option, a free-form "Other" input, and (for store-backed cards) a subtle
    // dismiss. spec: { question, options, allowOther, onAnswer(text, card),
    // onDismiss(card) | null, subject?: { table, rowId, label } }. Shared by
    // the pending-store cards (POST answer/dismiss) and the in-turn chat card
    // (answer = next chat message). The subject (if present) displays as a
    // secondary line under the question text, clickable to navigate to that record.
    function buildQuestionCard(spec) {
      var card = document.createElement('div');
      card.className = 'q-card';
      var head = document.createElement('div'); head.className = 'q-head';
      var text = document.createElement('div'); text.className = 'q-text';
      text.textContent = spec.question;
      head.appendChild(text);
      // Display the subject (the record this question is about) as a secondary line.
      if (spec.subject) {
        var subhead = document.createElement('div'); subhead.className = 'q-subject';
        var sublink = document.createElement('a');
        sublink.href = '#'; // link styling only; navigation via click handler
        sublink.textContent = 'Re: ' + spec.subject.label; // textContent doesn't parse HTML, so no escapeHtml needed
        // Navigate to the subject record when clicked (same pattern as openSearchHit).
        sublink.addEventListener('click', function (e) {
          e.preventDefault();
          if (typeof openSearchHit === 'function') {
            openSearchHit(spec.subject.table, spec.subject.rowId);
          }
        });
        subhead.appendChild(sublink);
        head.appendChild(subhead);
      }
      if (spec.onDismiss) {
        var dis = document.createElement('button');
        dis.className = 'q-dismiss'; dis.type = 'button';
        dis.title = 'Dismiss'; dis.textContent = '✕';
        dis.addEventListener('click', function () { spec.onDismiss(card); });
        head.appendChild(dis);
      }
      card.appendChild(head);
      var opts = document.createElement('div'); opts.className = 'q-options';
      (spec.options || []).forEach(function (opt) {
        var b = document.createElement('button');
        b.className = 'q-opt'; b.type = 'button'; b.textContent = opt;
        b.addEventListener('click', function () { spec.onAnswer(opt, card); });
        opts.appendChild(b);
      });
      card.appendChild(opts);
      if (spec.allowOther !== false) {
        var row = document.createElement('div'); row.className = 'q-other';
        var input = document.createElement('input');
        input.type = 'text'; input.className = 'q-other-input'; input.placeholder = 'Other…';
        var send = document.createElement('button');
        send.className = 'q-other-send'; send.type = 'button'; send.textContent = 'Answer';
        var submitOther = function () {
          var v = (input.value || '').trim();
          if (v) spec.onAnswer(v, card);
        };
        send.addEventListener('click', submitOther);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitOther(); });
        row.appendChild(input); row.appendChild(send);
        card.appendChild(row);
      }
      var err = document.createElement('div'); err.className = 'q-error'; err.hidden = true;
      card.appendChild(err);
      return card;
    }
    function qCardBusy(card, busy) {
      var els = card.querySelectorAll('button, input');
      for (var i = 0; i < els.length; i++) els[i].disabled = !!busy;
    }
    function qCardError(card, msg) {
      var err = card.querySelector('.q-error');
      if (err) { err.hidden = false; err.textContent = msg || 'Something went wrong'; }
    }
    // Collapse an answered/dismissed card into a short resolved line.
    function qCardResolve(card, line) {
      card.classList.add('q-resolved');
      card.textContent = line;
    }
    function postQuestionAction(id, path, body) {
      return fetch('/api/questions/' + encodeURIComponent(id) + '/' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {})
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
          return j;
        });
      });
    }
    function qMarkResolved(id, card, line) {
      delete qCards[id];
      qPendingCount = Math.max(0, qPendingCount - 1);
      qRenderBanner();
      if (typeof setQuestionsTab === 'function') setQuestionsTab(qPendingCount);
      updateQuestionDot();
      qCardResolve(card, line);
      // The resolved line lingers briefly as confirmation, then clears itself.
      setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 8000);
    }
    function renderPendingQuestion(q) {
      var host = qStack();
      if (!host || qCards[q.id]) return;
      // Parse the context_json to extract the subject (what the question is about).
      var context = null;
      var subject = null;
      if (q.context_json) {
        try {
          context = JSON.parse(q.context_json);
          if (context && context.subject) subject = context.subject;
        } catch (e) {
          // malformed context_json — just proceed without subject
        }
      }
      var card = buildQuestionCard({
        question: q.question,
        options: q.options || [],
        allowOther: q.allowOther !== false,
        subject: subject,
        onAnswer: function (text, card) {
          qCardBusy(card, true);
          postQuestionAction(q.id, 'answer', { answer: text }).then(function () {
            qMarkResolved(q.id, card, '✓ ' + text);
          }).catch(function (e) {
            // The question stays pending server-side — re-enable + show why.
            qCardBusy(card, false);
            qCardError(card, e.message);
          });
        },
        onDismiss: function (card) {
          // Dismissing drops a pending question for good — confirm so a stray
          // click can't discard it silently.
          if (typeof confirm === 'function' && !confirm('Dismiss this question?')) return;
          qCardBusy(card, true);
          postQuestionAction(q.id, 'dismiss').then(function () {
            qMarkResolved(q.id, card, 'Dismissed');
          }).catch(function (e) {
            qCardBusy(card, false);
            qCardError(card, e.message);
          });
        }
      });
      qCards[q.id] = card;
      host.appendChild(card);
    }
    // Reconcile the cards + dot against the server's pending list. openOnNew:
    // a brand-new question switches to the Analytics view, where the dock
    // shows the cards (feed events pass true; the boot fetch passes false).
    // Resilient by design: a failed fetch must never break chat — it just
    // leaves the current cards as they are.
    function refreshQuestions(openOnNew) {
      return fetchJson('/api/questions/pending').then(function (d) {
        var qs = (d && d.questions) || [];
        var pendingIds = {};
        qs.forEach(function (q) { pendingIds[q.id] = true; });
        // Drop cards resolved elsewhere (another tab answered or dismissed).
        Object.keys(qCards).forEach(function (id) {
          if (!pendingIds[id]) {
            var el = qCards[id];
            delete qCards[id];
            if (el && el.parentNode) el.parentNode.removeChild(el);
          }
        });
        var hadNew = false;
        qs.forEach(function (q) {
          if (!qCards[q.id]) { hadNew = true; renderPendingQuestion(q); }
        });
        qPendingCount = qs.length;
        qRenderBanner();
        // Keep the Configure-view 'Data Questions' tab + its unread badge in sync.
        // The tab appears while questions are outstanding and vanishes at zero.
        if (typeof setQuestionsTab === 'function') setQuestionsTab(qPendingCount);
        if (openOnNew && hadNew) {
          // A newly-arrived question announces itself to screen readers either way.
          qAnnounce(qPendingCount === 1
            ? 'A new data question is waiting.'
            : qPendingCount + ' data questions are waiting.');
          // NEVER switch views on a new question — being yanked from Configure to
          // Analytics mid-work is exactly the confusing behavior this replaces. The
          // question already surfaces where the user is: the docked cards in Analytics,
          // the Data Questions tab (+badge) in Configure. When the dock isn't showing
          // (Configure / editing), a non-stealing toast points at the tab.
          if (!qDockShowing()) qNotifyNewQuestion();
        }
        updateQuestionDot();
      }).catch(function () { /* resilient — chat keeps working without questions */ });
    }
    // A 'question' feed event arrived (new / answered / dismissed) — reconcile.
    function onQuestionFeedEvent() { refreshQuestions(true); }
    // Wipe all per-workspace question state, then reconcile against the workspace we
    // just switched to. Without this, the previous workspace's Data Questions tab +
    // unread badge (module-level tabs/qCards/qPendingCount) linger in the strip and
    // misreport the new workspace's count (a cross-workspace leak) until the user
    // happens to click the tab or a new question arrives. Called from the switch path.
    function resetQuestionsState() {
      Object.keys(qCards).forEach(function (id) {
        var el = qCards[id];
        delete qCards[id];
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });
      qPendingCount = 0;
      qRenderBanner();
      if (typeof setQuestionsTab === 'function') setQuestionsTab(0);
      updateQuestionDot();
      // Load the NEW workspace's pending questions (re-adds the tab if it has any).
      refreshQuestions(false);
    }
    function initQuestions() {
      // Flipping between Configure and Analytics changes whether the cards are
      // on screen, so the dot re-evaluates on every hash change.
      window.addEventListener('hashchange', updateQuestionDot);
      refreshQuestions(false);
    }
    // The model asked mid-turn (the ask_user tool): render the same card inline
    // in the conversation; the chosen option (or free-form text) is sent as the
    // next chat message through the normal composer path.
    function renderChatQuestion(ev) {
      railEmptyGone();
      var feedEl = railFeedEl(); if (!feedEl) return;
      var wrap = document.createElement('div');
      wrap.className = 'chat-msg assistant q-inline';
      var card = buildQuestionCard({
        question: ev.question,
        options: ev.options || [],
        allowOther: ev.allowOther !== false,
        onAnswer: function (text, card) {
          qCardResolve(card, '✓ ' + text);
          qSendAnswerAsChat(text, 0);
        },
        onDismiss: null
      });
      wrap.appendChild(card);
      feedEl.appendChild(wrap);
      feedEl.scrollTop = feedEl.scrollHeight;
    }
    // The question event lands moments before the stream's 'done'; if the user
    // clicks before the turn fully closes, wait (bounded) for the composer to
    // free up instead of dropping the answer on sendChat's busy guard.
    function qSendAnswerAsChat(text, tries) {
      if (chatBusy && tries < 40) {
        setTimeout(function () { qSendAnswerAsChat(text, tries + 1); }, 150);
        return;
      }
      sendChat(text);
    }

    // The Configure-view Data Questions page (route #/questions). Lists the pending
    // ingestion questions as the SAME interactive cards used in the Analytics dock —
    // so answering here or there is identical — but this is the surface used while the
    // user is in Configure, so a new question never has to yank them to Analytics.
    // Rebuilt fresh from the store on each visit.
    function renderQuestionsView(content) {
      if (!content) return;
      // Capture the render generation (bumped on every renderRoute) so an in-flight
      // fetch that resolves AFTER the user has navigated away refuses to commit — both
      // its DOM writes and its setQuestionsTab (which could otherwise resurrect a tab
      // that was correctly removed when the last question resolved elsewhere).
      var myGen = renderGen;
      content.innerHTML =
        '<div class="dq-view">' +
          '<div class="dq-head">' +
            '<h1 class="dq-title">Data Questions</h1>' +
            '<p class="dq-sub">A few quick questions about the files you added — answering them helps organize your data. Nothing is held up while these wait.</p>' +
          '</div>' +
          '<div class="dq-list" id="dq-list"><div class="dq-empty">Loading…</div></div>' +
        '</div>';
      var list = document.getElementById('dq-list');
      fetchJson('/api/questions/pending').then(function (d) {
        if (myGen !== renderGen) return; // a newer view is showing — drop this result
        var qs = (d && d.questions) || [];
        if (typeof setQuestionsTab === 'function') setQuestionsTab(qs.length);
        if (!list) return;
        if (!qs.length) {
          list.innerHTML = '<div class="dq-empty">All caught up — no questions right now.</div>';
          return;
        }
        list.innerHTML = '';
        qs.forEach(function (q) {
          // Parse the context_json to extract the subject (what the question is about).
          var context = null;
          var subject = null;
          if (q.context_json) {
            try {
              context = JSON.parse(q.context_json);
              if (context && context.subject) subject = context.subject;
            } catch (e) {
              // malformed context_json — just proceed without subject
            }
          }
          var card = buildQuestionCard({
            question: q.question,
            options: q.options || [],
            allowOther: q.allowOther !== false,
            subject: subject,
            onAnswer: function (text, c) {
              qCardBusy(c, true);
              postQuestionAction(q.id, 'answer', { answer: text }).then(function () {
                qCardResolve(c, '✓ ' + text);
                qDqAfterResolve(q.id, c);
              }).catch(function (e) { qCardBusy(c, false); qCardError(c, e.message); });
            },
            onDismiss: function (c) {
              if (typeof confirm === 'function' && !confirm('Dismiss this question?')) return;
              qCardBusy(c, true);
              postQuestionAction(q.id, 'dismiss').then(function () {
                qCardResolve(c, 'Dismissed');
                qDqAfterResolve(q.id, c);
              }).catch(function (e) { qCardBusy(c, false); qCardError(c, e.message); });
            }
          });
          list.appendChild(card);
        });
      }).catch(function () {
        if (list) list.innerHTML = '<div class="dq-empty">Could not load questions — try again.</div>';
      });
    }
    // After a card on the Data Questions page resolves: drop the dock's TWIN card
    // (both the map entry AND its DOM node — deleting only the map entry would strand
    // a stale, still-clickable card in the Analytics dock that refreshQuestions can no
    // longer reap, since it reconciles by looking ids up in qCards), decrement the
    // count, and sync the tab (which routes back to Tables at zero).
    function qDqAfterResolve(id, card) {
      var twin = qCards[id];
      if (twin) {
        delete qCards[id];
        if (twin.parentNode) twin.parentNode.removeChild(twin);
      }
      qPendingCount = Math.max(0, qPendingCount - 1);
      // Repaint the banner synchronously — the sibling resolve paths (qMarkResolved,
      // refreshQuestions, resetQuestionsState) all do; without it a resolve from the
      // Configure Data Questions tab leaves a stale "▸ N data questions waiting" banner
      // until a later feed event happens to reconcile.
      qRenderBanner();
      if (typeof setQuestionsTab === 'function') setQuestionsTab(qPendingCount);
      updateQuestionDot();
      setTimeout(function () { if (card && card.parentNode) card.parentNode.removeChild(card); }, 6000);
    }

`;
