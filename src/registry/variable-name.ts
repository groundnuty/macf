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
