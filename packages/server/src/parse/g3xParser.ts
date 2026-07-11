import type { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import {
  conversionFor,
  normalizeUnit,
  parseG3xTimestamp,
  PARAM_BY_NAME,
  type Convert,
  type ParameterMap,
  type Sample,
} from '@foqa/shared';

/**
 * Streaming, garbage-tolerant G3X CSV parser (Stage A).
 *
 * File shape: `#airframe_info ...` metadata line, a `#`-prefixed units row,
 * a column-name row, then 1 Hz data rows in local time + UTC offset.
 * Tolerates torn last rows, `---`/empty null tokens, duplicate timestamps
 * (first wins) and out-of-order rows (sorted). Columns not in the parameter
 * map — or whose units can't be safely converted — are preserved verbatim in
 * `extra` rather than guessed at.
 */

export interface ParsedLog {
  metadata: Record<string, string>;
  samples: Sample[];
  warnings: string[];
  /** Rows discarded (unparseable time, torn beyond use). */
  droppedRows: number;
  duplicateRows: number;
}

const NULL_TOKENS = new Set(['', '---', '--', 'NaN']);

interface ColumnPlan {
  index: number;
  header: string;
  kind: 'canonical' | 'extra';
  canonical?: string;
  convert?: Convert;
}

function parseAirframeInfo(line: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const m of line.matchAll(/([a-zA-Z_][a-zA-Z0-9_ ]*)=("([^"]*)"|[^,]*)/g)) {
    const key = m[1]!.trim();
    const value = (m[3] ?? m[2] ?? '').trim();
    if (key) meta[key] = value;
  }
  return meta;
}

export async function parseG3xCsv(input: Readable, map: ParameterMap): Promise<ParsedLog> {
  const warnings: string[] = [];
  const metadata: Record<string, string> = {};
  let unitsRow: string[] | null = null;
  let plan: ColumnPlan[] | null = null;
  let timeIdx: { date: number; time: number; offset: number } | null = null;

  const parser = parse({
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    comment: undefined,
  });

  const byTs = new Map<number, Sample>();
  let droppedRows = 0;
  let duplicateRows = 0;
  let headerDone = false;

  const buildPlan = (headers: string[]): void => {
    const dateIdx = headers.findIndex((h) => map.time.date.includes(h));
    const tIdx = headers.findIndex((h) => map.time.time.includes(h));
    const oIdx = headers.findIndex((h) => map.time.utcOffset.includes(h));
    if (dateIdx < 0 || tIdx < 0 || oIdx < 0) {
      throw new Error(
        `G3X header missing time columns (found date=${dateIdx}, time=${tIdx}, offset=${oIdx})`,
      );
    }
    timeIdx = { date: dateIdx, time: tIdx, offset: oIdx };
    plan = headers.map((header, index): ColumnPlan => {
      if (index === dateIdx || index === tIdx || index === oIdx)
        return { index, header, kind: 'extra' }; // consumed separately
      const canonical = map.headerToCanonical.get(header);
      if (!canonical) return { index, header, kind: 'extra' };
      const def = PARAM_BY_NAME.get(canonical)!;
      const sourceUnit = unitsRow?.[index] !== undefined ? normalizeUnit(unitsRow[index]!) : def.unit;
      const convert = conversionFor(sourceUnit, def.unit);
      if (!convert) {
        warnings.push(
          `column "${header}": unit "${sourceUnit}" cannot be converted to ${def.unit}; keeping raw in extra`,
        );
        return { index, header, kind: 'extra' };
      }
      return { index, header, kind: 'canonical', canonical, convert };
    });
    // exclude time columns from the extra plan
    plan = plan.filter(
      (c) => !(c.kind === 'extra' && [dateIdx, tIdx, oIdx].includes(c.index)),
    );
  };

  for await (const record of input.pipe(parser)) {
    const cells = record as string[];
    const first = cells[0] ?? '';
    if (!headerDone) {
      if (first.startsWith('#airframe_info') || first.startsWith('# airframe_info')) {
        Object.assign(metadata, parseAirframeInfo(cells.join(',')));
        continue;
      }
      if (first.startsWith('#')) {
        unitsRow = cells.map((c) => c.replace(/^#/, '').trim());
        continue;
      }
      // column header row
      buildPlan(cells.map((c) => c.trim()));
      headerDone = true;
      continue;
    }
    if (first.startsWith('#')) continue; // stray comment mid-file

    const ti = timeIdx!;
    const dateCell = cells[ti.date];
    const timeCell = cells[ti.time];
    const offsetCell = cells[ti.offset];
    if (dateCell === undefined || timeCell === undefined || offsetCell === undefined) {
      droppedRows++;
      continue;
    }
    const ts = parseG3xTimestamp(dateCell, timeCell, offsetCell);
    if (!ts) {
      droppedRows++;
      continue;
    }
    if (byTs.has(ts.getTime())) {
      duplicateRows++;
      continue; // first row for a timestamp wins
    }

    const values: Record<string, number | null> = {};
    const extra: Record<string, string> = {};
    for (const col of plan!) {
      const raw = cells[col.index];
      if (col.kind === 'canonical') {
        if (raw === undefined || NULL_TOKENS.has(raw)) {
          values[col.canonical!] = null;
        } else {
          const n = Number(raw);
          values[col.canonical!] = Number.isFinite(n) ? col.convert!(n) : null;
        }
      } else if (raw !== undefined && !NULL_TOKENS.has(raw)) {
        extra[col.header] = raw;
      }
    }
    byTs.set(ts.getTime(), { ts, values, extra });
  }

  if (!headerDone) throw new Error('no column header row found — not a G3X log?');

  const samples = [...byTs.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  if (duplicateRows > 0) warnings.push(`${duplicateRows} duplicate-timestamp rows ignored`);
  if (droppedRows > 0) warnings.push(`${droppedRows} unparseable rows dropped`);
  return { metadata, samples, warnings, droppedRows, duplicateRows };
}
