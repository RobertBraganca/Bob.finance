import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './server/src/db/schema.ts',
  out: './server/drizzle',
  dbCredentials: { url: 'file:./data/finance.db' },
  strict: true,
  verbose: false,
})
