// Conventional Commits rules for @nais/apm. This underpins release-please's
// version inference and CHANGELOG generation. package.json has "type": "module",
// so this file is ESM (export default).
export default {
  extends: ['@commitlint/config-conventional'],
};
