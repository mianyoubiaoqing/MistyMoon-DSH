import { describe, expect, it } from 'vitest'
import {
  WorkProfileController,
  type WorkProfileEventLike,
} from '../src/index.js'

function events(...data: WorkProfileEventLike[]): WorkProfileEventLike[] {
  return data
}

describe('WorkProfileController', () => {
  it('commits a versioned selection that affects only the next fresh activation', () => {
    const controller = new WorkProfileController({
      defaultProfile: 'anchored-standard',
      availableProfiles: ['anchored-standard', 'anchored-standard-jspace'],
    })
    const before = controller.resolveNextActivation([])
    const switched = controller.switchProfile([], {
      version: 1,
      requestId: 'switch-1',
      expectedRevision: 1,
      targetProfile: 'anchored-standard-jspace',
      reason: 'Use the reviewed complex-task profile.',
      ownerConfirmed: true,
    })

    expect(before).toEqual({ version: 1, revision: 1, profile: 'anchored-standard' })
    expect(switched).toMatchObject({ status: 'committed', previous: before })
    expect(switched.commit).toMatchObject({
      version: 1,
      requestId: 'switch-1',
      previousRevision: 1,
      revision: 2,
      profile: 'anchored-standard-jspace',
    })
    expect(controller.resolveNextActivation([])).toEqual(before)
    expect(controller.resolveNextActivation(events({
      type: 'mistymoon:work-profile-switched',
      data: switched.commit!,
    }))).toEqual({ version: 1, revision: 2, profile: 'anchored-standard-jspace' })
  })

  it('requires confirmation for capability increase and rejects stale revisions', () => {
    const controller = new WorkProfileController({
      defaultProfile: 'anchored-standard',
      availableProfiles: ['anchored-standard', 'anchored-standard-jspace'],
    })
    const request = {
      version: 1 as const,
      requestId: 'switch-2',
      expectedRevision: 1,
      targetProfile: 'anchored-standard-jspace' as const,
      reason: 'Complex task.',
      ownerConfirmed: false,
    }

    expect(controller.switchProfile([], request)).toMatchObject({ status: 'confirmation-required' })
    expect(controller.switchProfile([], { ...request, expectedRevision: 9, ownerConfirmed: true }))
      .toMatchObject({ status: 'revision-conflict' })
  })

  it('is idempotent by request id and fails loud for unavailable profiles', () => {
    const full = new WorkProfileController({
      defaultProfile: 'anchored-standard',
      availableProfiles: ['anchored-standard', 'anchored-standard-jspace'],
    })
    const first = full.switchProfile([], {
      version: 1,
      requestId: 'switch-3',
      expectedRevision: 1,
      targetProfile: 'anchored-standard-jspace',
      reason: 'Complex task.',
      ownerConfirmed: true,
    })
    const log = events({ type: 'mistymoon:work-profile-switched', data: first.commit! })

    expect(full.switchProfile(log, {
      version: 1,
      requestId: 'switch-3',
      expectedRevision: 1,
      targetProfile: 'anchored-standard-jspace',
      reason: 'Retry.',
      ownerConfirmed: true,
    })).toMatchObject({ status: 'already-committed', selection: { revision: 2 } })

    const defaultOnly = new WorkProfileController({
      defaultProfile: 'anchored-standard',
      availableProfiles: ['anchored-standard'],
    })
    expect(defaultOnly.switchProfile([], {
      version: 1,
      requestId: 'switch-4',
      expectedRevision: 1,
      targetProfile: 'anchored-standard-jspace',
      reason: 'Unavailable experiment.',
      ownerConfirmed: true,
    })).toMatchObject({ status: 'not-ready' })
  })
})
