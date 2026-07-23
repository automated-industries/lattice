// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const chatCss = `    /* ── Chat bubbles + tool pills ─────────────────────── */
    .chat-msg { display: flex; flex-wrap: wrap; animation: feedIn var(--dur-2) ease-out; }
    .chat-msg.user { justify-content: flex-end; }
    .chat-msg.assistant { justify-content: flex-start; }
    /* A relative timestamp under each bubble; recomputed on reload so an older reply
       reads as older. Full-width row (flex-wrap) so it sits beneath the bubble. */
    .chat-time { flex-basis: 100%; font-size: 11px; color: var(--text-muted); margin-top: 2px; }
    .chat-msg.user .chat-time { text-align: right; }
    .chat-msg.assistant .chat-time { text-align: left; padding-left: 28px; }
    /* A follow-up typed mid-turn: dimmed, tagged "queued", sent when the turn ends. */
    .chat-msg.queued { opacity: 0.6; }
    .chat-queued-tag {
      align-self: center; margin: 0 6px; flex: none;
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);
    }
    /* The assistant speaks with the Lattice mark as its avatar (same grid glyph as the
       brand logo / favicon) so replies read as coming from Lattice. One mark per
       assistant turn (incl. the "typing…" bubble), to the left of the bubble; user
       turns are unaffected. */
    .chat-msg.assistant::before {
      content: ""; flex: none; align-self: flex-start;
      width: 20px; height: 20px; margin-right: 8px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='.5' y='.5' width='23' height='23' rx='5' fill='%23eff6ff' stroke='%23dbeafe'/%3E%3Cpath stroke='%233b82f6' stroke-width='1.25' stroke-linecap='round' d='M6 6h12M6 12h12M6 18h12M6 6v12M12 6v12M18 6v12'/%3E%3Cg fill='%233b82f6'%3E%3Ccircle cx='6' cy='6' r='1.7'/%3E%3Ccircle cx='12' cy='6' r='1.7'/%3E%3Ccircle cx='18' cy='6' r='1.7'/%3E%3Ccircle cx='6' cy='12' r='1.7'/%3E%3Ccircle cx='12' cy='12' r='2.4'/%3E%3Ccircle cx='18' cy='12' r='1.7'/%3E%3Ccircle cx='6' cy='18' r='1.7'/%3E%3Ccircle cx='12' cy='18' r='1.7'/%3E%3Ccircle cx='18' cy='18' r='1.7'/%3E%3C/g%3E%3C/svg%3E");
      background-size: contain; background-repeat: no-repeat; background-position: center;
    }
    .chat-bubble {
      max-width: 85%; padding: 8px 12px; font-size: 14px; line-height: 1.45;
      white-space: pre-wrap; word-break: break-word;
    }
    .chat-bubble.user {
      background: var(--accent);
      color: var(--btn-text);
      border-radius: var(--r-xl) var(--r-xl) var(--r-xs) var(--r-xl);
      box-shadow: 0 2px 10px -2px color-mix(in srgb, var(--accent-deep) 50%, transparent);
    }
    /* A sent user message can carry attached-file chips below its bubble (stacked,
       right-aligned) so an attachment stays visible in the feed after sending — it
       used to vanish when sent together with a text message. */
    .chat-user-stack { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; max-width: 85%; }
    .chat-msg-files { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }
    .chat-msg-file {
      display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
      padding: 2px 8px; font-size: 12px; line-height: 1.3;
      background: var(--surface-2); color: var(--text);
      border: 1px solid rgba(15, 23, 42, 0.08); border-radius: var(--r-md, 8px);
    }
    .chat-msg-file-ic { flex: none; }
    .chat-msg-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
    .chat-bubble.assistant {
      background: var(--surface-2); color: var(--text); border: 1px solid rgba(15, 23, 42, 0.04);
      border-radius: var(--r-xl) var(--r-xl) var(--r-xl) var(--r-xs);
      white-space: normal; /* rendered Markdown flows as HTML, not pre-wrapped */
    }
    /* Markdown elements rendered inside assistant chat bubbles */
    .chat-bubble.assistant > :first-child { margin-top: 0; }
    .chat-bubble.assistant > :last-child { margin-bottom: 0; }
    .chat-bubble.assistant p { margin: 0 0 8px; }
    .chat-bubble.assistant ul, .chat-bubble.assistant ol { margin: 0 0 8px; padding-left: 20px; }
    .chat-bubble.assistant li { margin: 2px 0; }
    .chat-bubble.assistant h3, .chat-bubble.assistant h4,
    .chat-bubble.assistant h5, .chat-bubble.assistant h6 {
      margin: 10px 0 4px; font-weight: 700; line-height: 1.3;
    }
    .chat-bubble.assistant h3 { font-size: 15px; }
    .chat-bubble.assistant h4 { font-size: 14px; }
    .chat-bubble.assistant h5, .chat-bubble.assistant h6 { font-size: 14px; }
    .chat-bubble.assistant a { color: var(--accent); text-decoration: underline; }
    .chat-bubble.assistant strong { font-weight: 700; }
    /* An inline notice for a recoverable problem (e.g. out of prepaid tokens): a
       red-tinted assistant bubble, distinct from a normal answer. */
    .chat-bubble.assistant.notice-error {
      background: color-mix(in srgb, var(--danger, #c0392b) 8%, var(--surface-2));
      border-color: color-mix(in srgb, var(--danger, #c0392b) 40%, transparent);
      color: var(--danger, #c0392b);
    }
    .chat-bubble.assistant.notice-error a { color: var(--danger, #c0392b); font-weight: 600; }
    /* Record references in an answer are the words themselves, linked inline —
       a dotted underline that flows with the sentence (no boxed pill). Click
       navigates to the record in the workspace. */
    .chat-bubble.assistant .lattice-ref {
      color: var(--accent); text-decoration: none; font-weight: 600; cursor: pointer;
      background: color-mix(in srgb, var(--accent) 8%, transparent);
      border-bottom: 1px dotted color-mix(in srgb, var(--accent) 55%, transparent);
      border-radius: var(--r-xs); padding: 0 2px;
    }
    .chat-bubble.assistant .lattice-ref:hover,
    .chat-bubble.assistant .lattice-ref:focus-visible {
      background: color-mix(in srgb, var(--accent) 16%, transparent);
      border-bottom-style: solid;
    }
    .chat-bubble.assistant code {
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-xs);
      padding: 0 4px; font-family: var(--font-mono); font-size: 12px;
    }
    .chat-bubble.assistant pre {
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-sm);
      padding: 8px; margin: 0 0 8px; overflow-x: auto;
    }
    .chat-bubble.assistant pre code { background: none; border: none; padding: 0; white-space: pre; }
    /* The assistant's data changes render as activity-feed cards (.feed-item) in
       the rail — there is no separate inline pill style. Reads emit no card.
       Typing indicator: three pulsing dots shown in an assistant bubble while
       the model is generating (before the first text delta of a turn). */
    .chat-typing { display: inline-flex; align-items: center; gap: 4px; padding: 2px 0; }
    .chat-typing i {
      width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted);
      display: inline-block; animation: chat-typing-kf 1.2s ease-in-out infinite;
    }
    .chat-typing i:nth-child(2) { animation-delay: 0.18s; }
    .chat-typing i:nth-child(3) { animation-delay: 0.36s; }
    @keyframes chat-typing-kf {
      0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
      30% { opacity: 0.9; transform: translateY(-2px); }
    }
    .rail-composer {
      flex: 0 0 auto; border-top: 1px solid rgba(15, 23, 42, 0.04); padding: 10px 12px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.6) 40%);
    }
    .rail-composer textarea {
      width: 100%; min-width: 0; resize: none; min-height: 38px; max-height: 160px;
      background: var(--surface-2); color: var(--text);
      border: 1px solid var(--border-strong); border-radius: var(--r-md);
      padding: 8px 10px; font: inherit; font-size: 14px; line-height: 1.4;
      /* Wrap instead of overflowing: min-width:0 lets the flex child shrink so
         text reflows to the rail width, and overflow-wrap breaks long tokens
         (URLs) that have no space to wrap at. JS auto-grows height to fit. */
      overflow-wrap: break-word; word-break: break-word;
    }
    /* While a voice note is being recorded/transcribed the textarea is read-only
       (shows a "Listening…" / "Transcribing…" placeholder, not editable). */
    .rail-composer textarea.recording { opacity: 0.6; cursor: not-allowed; }
    .rail-composer .composer-row { display: flex; gap: 8px; align-items: flex-end; }
    .rail-composer .composer-send {
      flex: 0 0 auto; height: 38px; padding: 0 14px; border: none; border-radius: var(--r-md);
      background: var(--accent); color: var(--btn-text); font-weight: 600; cursor: pointer;
      box-shadow: none; transition: filter var(--dur-2) ease, box-shadow var(--dur-2) ease, transform 0.08s ease;
    }
    .rail-composer .composer-send:hover:not(:disabled) { filter: brightness(1.06); box-shadow: var(--shadow-2); }
    .rail-composer .composer-send:active:not(:disabled) { transform: translateY(1px); }
    .rail-composer .composer-send:disabled { opacity: 0.4; cursor: default; box-shadow: none; }
    .rail-composer .composer-setup { font-size: 13px; color: var(--text-muted); text-align: center; }
    .rail-composer .composer-setup a { color: var(--accent); }
    /* Private-mode toggle under the composer row. */
    .rail-composer .composer-private {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      margin-top: 6px; font-size: 12px; color: var(--text-muted); cursor: pointer;
    }
    .rail-composer .composer-private input { cursor: pointer; }
    /* On a local workspace the toggle is a checked, read-only indicator. */
    .rail-composer .composer-private.is-disabled { opacity: 0.6; cursor: default; }
    .rail-composer .composer-private.is-disabled input { cursor: not-allowed; }
    .rail-composer .composer-private-hint { color: var(--text-muted); opacity: 0.8; font-size: 11px; }
    .rail-composer .composer-mic {
      flex: 0 0 auto; height: 38px; width: 38px; font-size: 15px;
      border: 1px solid var(--border-strong); border-radius: var(--r-md);
      background: var(--surface-2); color: var(--text-muted); cursor: pointer;
    }
    .rail-composer .composer-mic.recording { background: var(--warn); color: var(--text); border-color: var(--warn); box-shadow: 0 0 14px -2px color-mix(in srgb, var(--hue-orange) 60%, transparent); }
    .rail-composer .composer-mic.transcribing { color: var(--accent); }
    /* No microphone available: faded + not-allowed, but still hoverable so the
       title tooltip ("No microphone available") shows. Not natively disabled —
       disabled buttons suppress the tooltip. */
    .rail-composer .composer-mic.composer-mic-unavailable { opacity: 0.4; cursor: not-allowed; box-shadow: none; }
    .rail-composer .mic-picker { flex: 0 0 auto; max-width: 150px; font-size: 12px; padding: 4px 6px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--surface); color: var(--text); }
    .rail-composer .composer-clip {
      flex: 0 0 auto; height: 38px; width: 38px;
      display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid var(--border-strong); border-radius: var(--r-md);
      background: var(--surface-2); color: var(--text-muted); cursor: pointer;
    }
    .rail-composer .composer-clip:hover { color: var(--text); border-color: var(--accent); }
    .rail-composer .composer-clip svg { width: 17px; height: 17px; display: block; }
  `;
