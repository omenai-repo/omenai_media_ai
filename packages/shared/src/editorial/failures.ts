/**
 * Recognises a stored failure message caused by how a request was built or authorised, not by the
 * service being busy or down: a response schema the provider couldn't compile, a request it
 * rejected (400), a refused key. Retrying such a request can't succeed; it needs a fix (ADR-046).
 * Usage limits and rate limits are not included: they clear on their own.
 */
export function isRequestConfigurationFailure(detail: string): boolean {
  return /compiled grammar is too large|too complex for compilation|schema_rejected|invalid_request|unauthori[sz]ed|api key|\b40[013]\b/i.test(
    detail,
  );
}
