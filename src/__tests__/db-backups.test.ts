import { describe, it, expect } from 'vitest';
import { parseBackupList, selectBackupsToPrune } from '../lib/db-backups.js';

describe('parseBackupList', () => {
  it('parses tab-separated stat output, newest first', () => {
    const out = [
      '/home/u/db-backup-2026-06-20.sql.gz\t1048576\t1718870400',
      '/home/u/db-backup-2026-06-25.sql.gz\t2097152\t1719273600',
    ].join('\n');
    const list = parseBackupList(out);
    expect(list).toHaveLength(2);
    expect(list[0].file).toBe('/home/u/db-backup-2026-06-25.sql.gz'); // newest first
    expect(list[0].sizeBytes).toBe(2097152);
    expect(list[1].mtime).toBe(1718870400);
  });

  it('tolerates an SSH banner/MOTD and skips non-matching lines', () => {
    const out = [
      'Welcome to Ubuntu 22.04',
      'Last login: ...',
      '/home/u/db-backup-a.sql.gz\t100\t1719273600',
      'some junk line without tabs',
      '/home/u/notanumber.sql.gz\tNaN\tNaN',
    ].join('\n');
    const list = parseBackupList(out);
    expect(list).toHaveLength(1);
    expect(list[0].file).toBe('/home/u/db-backup-a.sql.gz');
  });

  it('returns [] for empty input', () => {
    expect(parseBackupList('')).toEqual([]);
  });
});

describe('selectBackupsToPrune', () => {
  const now = 1_719_273_600; // fixed "now"
  const day = 86400;
  // newest → oldest
  const backups = [
    { file: 'd', sizeBytes: 1, mtime: now - 1 * day },
    { file: 'c', sizeBytes: 1, mtime: now - 3 * day },
    { file: 'b', sizeBytes: 1, mtime: now - 10 * day },
    { file: 'a', sizeBytes: 1, mtime: now - 30 * day },
  ];

  it('--keep N keeps the newest N, deletes the rest', () => {
    const { toDelete, toKeep } = selectBackupsToPrune(backups, { keep: 2 }, now);
    expect(toKeep.map((b) => b.file)).toEqual(['d', 'c']);
    expect(toDelete.map((b) => b.file)).toEqual(['b', 'a']);
  });

  it('--older-than D deletes backups older than D days', () => {
    const { toDelete, toKeep } = selectBackupsToPrune(backups, { olderThanDays: 5 }, now);
    expect(toDelete.map((b) => b.file)).toEqual(['b', 'a']); // 10d, 30d old
    expect(toKeep.map((b) => b.file)).toEqual(['d', 'c']);   // 1d, 3d
  });

  it('combines criteria with OR (deleted if beyond keep OR too old)', () => {
    const { toDelete } = selectBackupsToPrune(backups, { keep: 3, olderThanDays: 5 }, now);
    // beyond keep:3 → 'a'; older than 5d → 'b','a'  → union {b,a}
    expect(toDelete.map((b) => b.file).sort()).toEqual(['a', 'b']);
  });

  it('deletes nothing when no criteria are given', () => {
    const { toDelete, toKeep } = selectBackupsToPrune(backups, {}, now);
    expect(toDelete).toHaveLength(0);
    expect(toKeep).toHaveLength(4);
  });
});
