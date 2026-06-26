// Helpers for `db backups list/prune` — parsing the remote backup listing and
// deciding which `~/db-backup-*.sql.gz` files to prune. Kept pure (no I/O) so
// the listing command and the prune selection are unit-testable.

export interface RemoteBackup {
  file: string;
  sizeBytes: number;
  mtime: number; // epoch seconds
}

/**
 * Parse the output of `stat -c '%n\t%s\t%Y' <files>` — tab-separated
 * path / size-bytes / mtime-epoch, one per line. Tolerant of an SSH login
 * banner/MOTD and any non-matching lines (silently skipped). Returns
 * newest-first.
 */
export function parseBackupList(stdout: string): RemoteBackup[] {
  const out: RemoteBackup[] = [];
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length !== 3) continue;
    const file = parts[0].trim();
    const sizeBytes = Number(parts[1]);
    const mtime = Number(parts[2]);
    if (!file || !Number.isFinite(sizeBytes) || !Number.isFinite(mtime)) continue;
    out.push({ file, sizeBytes, mtime });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Decide which backups to delete. A backup is selected if it matches ANY given
 * criterion: it falls beyond the newest `keep`, OR it is older than
 * `olderThanDays`. The caller must supply at least one criterion (selecting all
 * is never implicit). Returns newest-first partitions.
 */
export function selectBackupsToPrune(
  backups: RemoteBackup[],
  opts: { keep?: number; olderThanDays?: number },
  nowEpoch: number,
): { toDelete: RemoteBackup[]; toKeep: RemoteBackup[] } {
  const sorted = [...backups].sort((a, b) => b.mtime - a.mtime);
  const cutoff = opts.olderThanDays != null ? nowEpoch - opts.olderThanDays * 86400 : null;
  const toDelete: RemoteBackup[] = [];
  const toKeep: RemoteBackup[] = [];
  sorted.forEach((b, i) => {
    const beyondKeep = opts.keep != null && i >= opts.keep;
    const tooOld = cutoff != null && b.mtime < cutoff;
    if (beyondKeep || tooOld) toDelete.push(b);
    else toKeep.push(b);
  });
  return { toDelete, toKeep };
}
