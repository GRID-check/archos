import { search as en } from '../dictionaries/en/search'
import { search as de } from '../dictionaries/de/search'
import { defineNamespace } from '../namespace'

export const searchCopy = defineNamespace('search', { en, de })
