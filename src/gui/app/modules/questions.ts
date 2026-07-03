// Auto-composed segment of the GUI client script (see modules/index.ts). Must stay
// INSIDE the client IIFE (uses fetchJson + the ask-lattice/onboarding helpers).
export const questionsJs = `
    // ────────────────────────────────────────────────────────────
    // Clarification questions — marginal automated inferences ask the user
    // instead of guessing. Pending questions (the server store) render as
    // interactive cards above the composer in the Ask panel; the in-turn
    // ask_user tool renders the same card inline in the conversation. While
    // ≥1 question is pending and the panel is closed, the panel trigger
    // carries a notification dot; a new question auto-opens the panel.
    // ────────────────────────────────────────────────────────────
    var qCards = {};        // pending-store question id → card element
    var qPendingCount = 0;  // live pending count (drives the trigger dot)
    function qContainer() { return document.getElementById('question-cards'); }
    function updateQuestionDot() {
      var trig = document.getElementById('ask-lattice-trigger');
      if (!trig) return;
      trig.classList.toggle('has-question', qPendingCount > 0 && !askLatticeOpen());
    }
    // Build one interactive question card: the question text, one button per
    // option, a free-form "Other" input, and (for store-backed cards) a subtle
    // dismiss. spec: { question, options, allowOther, onAnswer(text, card),
    // onDismiss(card) | null }. Shared by the pending-store cards (POST
    // answer/dismiss) and the in-turn chat card (answer = next chat message).
    function buildQuestionCard(spec) {
      var card = document.createElement('div');
      card.className = 'q-card';
      var head = document.createElement('div'); head.className = 'q-head';
      var text = document.createElement('div'); text.className = 'q-text';
      text.textContent = spec.question;
      head.appendChild(text);
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
      updateQuestionDot();
      qCardResolve(card, line);
      // The resolved line lingers briefly as confirmation, then clears itself.
      setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 8000);
    }
    function renderPendingQuestion(q) {
      var host = qContainer();
      if (!host || qCards[q.id]) return;
      var card = buildQuestionCard({
        question: q.question,
        options: q.options || [],
        allowOther: q.allowOther !== false,
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
    // a brand-new question auto-opens the assistant panel (feed events pass
    // true; the boot fetch passes false). Resilient by design: a failed fetch
    // must never break chat — it just leaves the current cards as they are.
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
        if (openOnNew && hadNew && !askLatticeOpen()) openAskLattice();
        updateQuestionDot();
      }).catch(function () { /* resilient — chat keeps working without questions */ });
    }
    // A 'question' feed event arrived (new / answered / dismissed) — reconcile.
    function onQuestionFeedEvent() { refreshQuestions(true); }
    function initQuestions() { refreshQuestions(false); }
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

`;
