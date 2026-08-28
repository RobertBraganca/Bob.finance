import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Deletes the database file.
 *
 * Deliberately does NOT import ./client: that module opens the database at
 * import time, which would leave this process holding a lock on the very
 * file it is trying to delete (EPERM on Windows).
 */
const dbPath = resolve(process.env.FINANCE_DB ?? 'data/finance.db')

for (const suffix of ['', '-wal', '-shm']) {
  rmSync(`${dbPath}${suffix}`, { force: true })
}

console.log(`[db] removido ${dbPath}`)
