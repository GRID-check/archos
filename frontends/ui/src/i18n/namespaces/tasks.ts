import { tasks as en } from '../dictionaries/en/tasks'
import { tasks as de } from '../dictionaries/de/tasks'
import { defineNamespace } from '../namespace'

export const tasksCopy = defineNamespace('tasks', { en, de })
