/**
 * Provenance versions stamped onto derived data. Bump PARSER_VERSION when the
 * CSV→samples transformation changes; bump ANALYZER_VERSION when enrichment,
 * phase detection, or event evaluation changes. `foqa reprocess` replays the
 * corresponding stage from the immutable raw archive.
 */
export const PARSER_VERSION = 1;
export const ANALYZER_VERSION = 1;
