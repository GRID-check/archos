import { projects as en } from '../dictionaries/en/projects'
import { projects as de } from '../dictionaries/de/projects'
import { defineNamespace } from '../namespace'

export const projectsCopy = defineNamespace('projects', { en, de })
