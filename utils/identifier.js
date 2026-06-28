// Validates that a table or column name is safe to interpolate into SQL DDL.
// PostgreSQL identifiers: start with letter or underscore, contain only
// letters, digits, underscores. Max 63 chars.

const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

const RESERVED_WORDS = [
  'id', 'created_at', // always added by platform
];

function isValidIdentifier(name) {
  return typeof name === 'string' && IDENTIFIER_REGEX.test(name);
}

function assertIdentifier(name, label = 'name') {
  if (!isValidIdentifier(name)) {
    const err = new Error(`Invalid ${label}: "${name}". Only letters, digits, and underscores allowed.`);
    err.status = 400;
    throw err;
  }
}

function isPlatformReserved(name) {
  return RESERVED_WORDS.includes(name.toLowerCase());
}

module.exports = { isValidIdentifier, assertIdentifier, isPlatformReserved };
