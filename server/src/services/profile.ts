import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { profileSettings } from '../db/schema'

export type AccountType = 'personal' | 'freelancer'

export type Profile = {
  displayName: string | null
  accountType: AccountType
}

export const DEFAULT_PROFILE: Profile = {
  displayName: null,
  accountType: 'freelancer',
}

export async function getProfile(): Promise<Profile> {
  const row = (await db.select().from(profileSettings).where(eq(profileSettings.id, 1)))[0]
  if (!row) return { ...DEFAULT_PROFILE }
  return { displayName: row.displayName, accountType: row.accountType }
}

export async function setProfile(patch: Partial<Profile>): Promise<Profile> {
  const existing = (await db.select().from(profileSettings).where(eq(profileSettings.id, 1)))[0]
  if (existing) {
    await db.update(profileSettings).set(patch).where(eq(profileSettings.id, 1))
  } else {
    await db.insert(profileSettings).values({ id: 1, ...DEFAULT_PROFILE, ...patch })
  }
  return getProfile()
}
