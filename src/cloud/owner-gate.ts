import type { Lattice } from '../lattice.js';
import { isScopedCloudMember } from '../framework/cloud-connect.js';
import { cloudError } from './errors.js';

/**
 * The owner-only refusal for a change to the SHAPE of a shared database, in one
 * place.
 *
 * WHY THIS IS A SHARED FUNCTION AND NOT A CHECK PER CALLER — the same reason the
 * managed refusal is one. It was a check per caller, written inline in the
 * request handlers, and the moment the operations behind those handlers became
 * callable without one, fifteen handlers kept the rule and the operations kept
 * none of it. A person on a scoped member role who clicked was refused; the same
 * person, on the same connection, reaching the same operation from a command,
 * from the assistant, or from a library call, was not. That is not a rule about
 * the operation — it is a rule about clicking.
 *
 * And these operations are not covered by anything else. They write the OWNER's
 * workspace configuration, which is a plain file write, and they run schema
 * statements, which row security does not govern; when the connected role lacks
 * the privilege to run one, the library deliberately routes it through an
 * owner-side helper rather than failing it, so the change really lands. So the
 * authorization has to travel WITH the operation.
 *
 * It is raised as a tagged failure rather than returned, because a capability
 * cannot answer with a status: the same call serves a request, a command, and a
 * library caller, and only one of those has a response to write. Each adapter
 * decides what the tag means on its own transport — the browser answers 403, a
 * command prints the sentence and exits non-zero.
 *
 * FALSE FOR EVERYTHING THAT IS NOT A SHARED CLOUD. SQLite, an unsecured
 * Postgres, and the owner are none of them a member, so an ordinary local
 * workspace is never gated and pays only a dialect comparison.
 *
 * @param verb what the caller was trying to do, as it completes the sentence
 *   "Only a cloud owner can …". Keep it the same wording the browser uses for
 *   the same operation, so the two surfaces cannot drift apart.
 */
export async function assertCloudOwner(db: Lattice, verb: string): Promise<void> {
  if (await isScopedCloudMember(db)) {
    throw cloudError('cloud_owner_only', `Only a cloud owner can ${verb}`);
  }
}
