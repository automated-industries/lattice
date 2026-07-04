// Auto-composed section of the GUI stylesheet (see styles/index.ts).
export const questionsCss = `    /* ── Clarification-question cards + trigger dot ───────────── */
    /* Pending-store cards live in their own strip between the chat feed and the
       composer; the in-turn ask_user card reuses the same .q-card inside a
       .chat-msg wrapper. Accent-tinted so a question reads as "needs you",
       distinct from conversation bubbles and activity cards. */
    .question-cards { flex: none; overflow-y: auto; max-height: 40%; }
    .question-cards:empty { display: none; }
    .question-cards .q-card { margin: 8px 10px; }
    .q-card {
      background: var(--accent-soft);
      border: 1px solid var(--accent);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 13px;
      color: var(--text);
      animation: feedIn 0.18s ease-out;
    }
    .q-head { display: flex; align-items: flex-start; gap: 8px; }
    .q-text { flex: 1; font-weight: 600; line-height: 1.4; }
    .q-dismiss {
      flex: none; background: none; border: none; cursor: pointer;
      color: var(--text-muted); font-size: 12px; padding: 0 2px; line-height: 1.4;
    }
    .q-dismiss:hover { color: var(--text); }
    .q-options { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .q-opt {
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border-strong); border-radius: 999px;
      padding: 4px 12px; font-size: 12.5px; cursor: pointer;
    }
    .q-opt:hover { border-color: var(--accent); color: var(--accent-deep); }
    .q-other { display: flex; gap: 6px; margin-top: 8px; }
    .q-other-input {
      flex: 1; min-width: 0; background: var(--surface); color: var(--text);
      border: 1px solid var(--border); border-radius: 8px; padding: 4px 8px; font-size: 12.5px;
    }
    .q-other-send {
      flex: none; background: var(--accent); color: var(--btn-text);
      border: none; border-radius: 8px; padding: 4px 10px; font-size: 12.5px; cursor: pointer;
    }
    .q-card button:disabled, .q-card input:disabled { opacity: 0.55; cursor: default; }
    .q-error { margin-top: 8px; color: var(--danger-deep); font-size: 12px; }
    .q-card.q-resolved {
      background: var(--surface-2); border-color: var(--border);
      color: var(--text-muted); font-size: 12.5px; font-weight: 500;
    }
    /* In-turn ask_user card: sits in the conversation flow like an assistant
       bubble (the wrapper carries the Gladys avatar), sized like one too. */
    .chat-msg.q-inline .q-card { max-width: 85%; }
    /* Notification dot on the Ask trigger while questions wait off-screen
       (i.e. the Analytics view — where the cards live — is not showing). */
    .ask-lattice-trigger { position: relative; }
    .ask-lattice-trigger.has-question::after {
      content: ''; position: absolute; top: -2px; right: -2px;
      width: 9px; height: 9px; border-radius: 50%;
      background: var(--danger); border: 2px solid var(--surface);
    }
`;
