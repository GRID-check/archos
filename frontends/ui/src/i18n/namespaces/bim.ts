import { bim as en } from '../dictionaries/en/bim'
import { bim as de } from '../dictionaries/de/bim'
import { defineNamespace } from '../namespace'

export const bimCopy = defineNamespace('bim', { en, de })
