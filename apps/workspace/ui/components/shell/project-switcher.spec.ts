/**
 * @vitest-environment node
 */
/**
 * The switcher offers where one works (ADR-0098): active and paused projects,
 * and a closed one only while it is the one open.
 */
import { describe, expect, it } from 'vitest'
import { switchableProjects } from './project-switcher'

const projects = [
  { id: 'a', name: 'Seestadt', status: 'active' as const },
  { id: 'p', name: 'Semmering', status: 'paused' as const },
  { id: 'c', name: 'Grinzing', status: 'closed' as const },
  { id: 'x', name: 'Ohne Status' },
]

describe('switchableProjects', () => {
  it('leaves out the closed projects', () => {
    expect(switchableProjects(projects).map((project) => project.id)).toEqual(['a', 'p', 'x'])
  })

  it('keeps a closed project while it is the one open', () => {
    expect(switchableProjects(projects, 'c').map((project) => project.id)).toEqual(['a', 'p', 'c', 'x'])
  })
})
