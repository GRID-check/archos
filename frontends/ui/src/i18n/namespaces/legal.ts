import { legal as en } from '../dictionaries/en/legal'
import { legal as de } from '../dictionaries/de/legal'
import { defineNamespace } from '../namespace'

export const legalCopy = defineNamespace('legal', { en, de })
