// migrate.ts — versioned schema changes for the SQLite files the brain owns.
//
// Each database has an ordered list of steps; step N takes the schema from version N-1 to N. The
// version lives in `pragma user_version`, not in a table: it is one integer per file, it needs no
// schema of its own to bootstrap, and it is transactional like everything else in SQLite. A file
// made before this existed reads 0, so step 1 of every list must accept both a missing schema and
// the current one (create ... if not exists, and a fix for each old shape still around).

import type { DatabaseSync } from "node:sqlite";

export type Migration = (db: DatabaseSync) => void;

/** Runs the steps a database has not seen, each in its own transaction with the version it ends at.
 *  A database already at the latest version is untouched; one ahead of this code is refused rather
 *  than guessed at. */
export function migrate(db: DatabaseSync, steps: Migration[]): void {
  const at = (db.prepare("pragma user_version").get() as { user_version: number }).user_version;
  if (at > steps.length) throw new Error(`database is at schema version ${at}, this code knows up to ${steps.length}`);
  for (let v = at + 1; v <= steps.length; v++) {
    db.exec("begin immediate");
    try {
      steps[v - 1](db);
      db.exec(`pragma user_version = ${v}`);
      db.exec("commit");
    } catch (e) {
      db.exec("rollback");
      throw e;
    }
  }
}
