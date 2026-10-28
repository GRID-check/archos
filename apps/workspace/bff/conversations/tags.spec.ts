/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import {
  canonicalConversationTagKey,
  CONVERSATION_TAG_KEYS,
  isConversationTagKey,
  LEGACY_CONVERSATION_TAG_KEYS,
  normalizeConversationTags,
} from './tags'

describe('conversation tags vocabulary', () => {
  it('recognises every key in the vocabulary', () => {
    for (const key of CONVERSATION_TAG_KEYS) {
      expect(isConversationTagKey(key)).toBe(true)
    }
  })

  it('maps every key stored before the English names onto the vocabulary, and never lists one as current', () => {
    for (const [legacy, mapped] of Object.entries(LEGACY_CONVERSATION_TAG_KEYS)) {
      expect(isConversationTagKey(legacy), legacy).toBe(false)
      expect(isConversationTagKey(mapped), legacy).toBe(true)
      expect(canonicalConversationTagKey(legacy)).toBe(mapped)
    }
    expect(normalizeConversationTags(['statik', 'structural', 'allgemein'])).toEqual(['structural', 'general'])
    expect(canonicalConversationTagKey('hygiene')).toBe('hygiene')
  })

  it('rejects unknown keys', () => {
    expect(isConversationTagKey('unknown')).toBe(false)
    expect(isConversationTagKey('')).toBe(false)
  })

  it('keeps only known keys, lowercased and trimmed', () => {
    expect(normalizeConversationTags(['Brandschutz', ' schallschutz ', 'nope'])).toEqual([
      'fire_safety',
      'sound_insulation',
    ])
  })

  it('de-duplicates while preserving first-seen order', () => {
    expect(normalizeConversationTags(['energy', 'structural', 'energy'])).toEqual(['energy', 'structural'])
  })

  it('returns an empty array for an all-unknown or empty input', () => {
    expect(normalizeConversationTags([])).toEqual([])
    expect(normalizeConversationTags(['foo', 'bar'])).toEqual([])
  })
})
