import { members as en } from '../dictionaries/en/members'
import { members as de } from '../dictionaries/de/members'
import { defineNamespace } from '../namespace'

export const membersCopy = defineNamespace('members', { en, de })
