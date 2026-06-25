// Auto-composed section of the GUI stylesheet (see styles/index.ts). The live
// brain-graph ingestion animation: a new node bubbles in, a new edge draws, and
// (above the per-element cap) the whole stage fades in. Honors reduced-motion.
export const graphIngestAnimationCss = `    /* ── Brain-graph ingest animation ──────────────────────── */
    @keyframes gnode-bubble-in {
      from { opacity: 0; transform: scale(0.2); }
      to { opacity: 1; transform: scale(1); }
    }
    .gnode-bubble-in {
      transform-box: fill-box;
      transform-origin: center;
      animation: gnode-bubble-in 0.45s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    @keyframes graph-feed-in {
      from { opacity: 0.35; }
      to { opacity: 1; }
    }
    .graph-feed-in { animation: graph-feed-in 0.5s ease; }
    @media (prefers-reduced-motion: reduce) {
      .gnode-bubble-in, .graph-feed-in { animation: none; }
    }

`;
