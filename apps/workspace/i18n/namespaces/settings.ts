import { settings as en } from '../dictionaries/en/settings'
import { settings as de } from '../dictionaries/de/settings'
import { defineNamespace } from '../namespace'

export const settingsCopy = defineNamespace('settings', { en, de })
