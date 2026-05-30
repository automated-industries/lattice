/**
 * Lattice's AI 2.0 surface as a first-class library API: the context organizer
 * plus the summarize/classify primitives it builds on. All AI is inert unless
 * an LLM client (backed by a configured key/auth) is supplied — Lattice does
 * not call out to any model on its own.
 */

export { organizeSource } from './organize.js';
export type {
  OrganizeOptions,
  OrganizeResult,
  OrganizedLink,
  OrganizedCreation,
} from './organize.js';

export { summarizeText, classifyLinks, parseMatches } from '../gui/ai/summarize.js';
export type { CatalogEntity, CatalogRecord, ClassifyMatch } from '../gui/ai/summarize.js';
export type { LlmClient, TurnParams, TurnResult, LlmMessage } from '../gui/ai/chat.js';
