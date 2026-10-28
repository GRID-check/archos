import { profile as en } from '../dictionaries/en/profile'
import { profile as de } from '../dictionaries/de/profile'
import { defineNamespace } from '../namespace'

export const profileCopy = defineNamespace('profile', { en, de })
