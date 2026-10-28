import { knowledge as en } from '../dictionaries/en/knowledge'
import { knowledge as de } from '../dictionaries/de/knowledge'
import { defineNamespace } from '../namespace'

export const knowledgeCopy = defineNamespace('knowledge', { en, de })
