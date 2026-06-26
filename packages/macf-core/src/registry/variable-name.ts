/**
 * Convert a project or agent name to the form used in GitHub Actions variable names.
 *
 * GitHub Actions variable names only accept [A-Z0-9_]. Hyphens (valid in
 * project/repo/agent names) must be converted to underscores. Names are
 * also uppercased by convention — see DR-005 for the registration schema.
 *
 * Examples:
 *   toVariableSegment('macf')             → 'MACF'
 *   toVariableSegment('academic-resume')  → 'ACADEMIC_RESUME'
 *   toVariableSegment('cv-architect')     → 'CV_ARCHITECT'
 *   toVariableSegment('with_underscore')  → 'WITH_UNDERSCORE'
 */
export function toVariableSegment(name: string): string {
  return name.toUpperCase().replace(/-/g, '_');
}

/**
 * Inverse of {@link toVariableSegment}: convert a GitHub-Variables-canonical
 * registry-key segment (uppercased, underscores) back to the canonical kebab
 * routing-label form used for agent identity + telemetry (`<role>-agent`).
 *
 * Idempotent on already-kebab input, so it is safe to apply to a name from
 * either source (a raw `to` arg that is already kebab, or a registry-key
 * suffix that is SCREAMING_SNAKE).
 *
 * Examples:
 *   fromVariableSegment('DEVOPS_AGENT') → 'devops-agent'
 *   fromVariableSegment('CV_ARCHITECT') → 'cv-architect'
 *   fromVariableSegment('devops-agent') → 'devops-agent'  (idempotent)
 *
 * LOSSY caveat: a name that legitimately contained a literal underscore
 * (e.g. 'with_underscore' → 'WITH_UNDERSCORE') round-trips to a hyphen
 * ('with-underscore'). MACF's canonical agent-naming convention is kebab
 * `<role>-agent` (no literal underscores), so this is correct for the
 * routing-label / telemetry-name use it is built for. Do NOT use it to
 * reconstruct a registry LOOKUP key — keep the original name for lookups.
 */
export function fromVariableSegment(segment: string): string {
  return segment.toLowerCase().replace(/_/g, '-');
}
