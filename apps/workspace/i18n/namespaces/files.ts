import { files as en } from '../dictionaries/en/files'
import { files as de } from '../dictionaries/de/files'
import { defineNamespace } from '../namespace'

export const filesCopy = defineNamespace('files', { en, de })
