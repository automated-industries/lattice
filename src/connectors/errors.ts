/**
 * Shared connector errors.
 *
 * Lives in its own module (not inside any one connector) so every connector and
 * the GUI routes reference a single {@link ConnectorUnavailableError} identity —
 * the route layer maps it to a 422 via `instanceof`, so a split identity would
 * silently break that mapping.
 */

/** Thrown when a connector is used but its prerequisites are missing. */
export class ConnectorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorUnavailableError';
  }
}
