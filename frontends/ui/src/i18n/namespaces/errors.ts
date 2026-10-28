import { errors as en } from '../dictionaries/en/errors'
import { errors as de } from '../dictionaries/de/errors'
import { defineNamespace } from '../namespace'

export const errorsCopy = defineNamespace('errors', { en, de })
