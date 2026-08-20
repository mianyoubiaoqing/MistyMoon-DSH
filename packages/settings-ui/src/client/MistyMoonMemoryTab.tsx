/** Dedicated Owner-facing Memory governance page. */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  MemoryBatchDecisionV1,
  MemoryBatchGovernanceResultV1,
  MemoryCandidate,
  MemoryConflictAssessmentV1,
  MemoryManagementSnapshotV1,
  MemorySourceViewV1,
} from '../contracts.js'

export interface MemorySearchFilters {
  query?: string
  memoryKind?: MemoryCandidate['memoryKind']
  visibility?: MemoryCandidate['visibility']
  recordStatus?: 'active' | 'inactive' | 'all'
  candidateStatus?: MemoryCandidate['status'] | 'all'
  limit?: number
}

export interface MistyMoonMemoryTabInjected {
  search: (filters: MemorySearchFilters) => Promise<MemoryManagementSnapshotV1>
  source: (entity: 'record' | 'candidate', id: string) => Promise<MemorySourceViewV1>
  assess: (candidateId: string) => Promise<MemoryConflictAssessmentV1>
  batch: (decisions: MemoryBatchDecisionV1[]) => Promise<MemoryBatchGovernanceResultV1>
  edit: (candidate: MemoryCandidate, content: string) => Promise<void>
  merge: (candidateIds: string[], content: string, memoryKind: MemoryCandidate['memoryKind'], visibility: MemoryCandidate['visibility']) => Promise<void>
}

export type MistyMoonMemoryTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.mistymoon'>
  & InjectFace<MistyMoonMemoryTabInjected>

const MEMORY_KINDS: MemoryCandidate['memoryKind'][] = [
  'preference', 'biographical', 'boundary', 'commitment', 'relationship', 'episode', 'state', 'summary',
]

export function MistyMoonMemoryTab({
  search,
  source,
  assess,
  batch,
  edit,
  merge,
  t,
}: MistyMoonMemoryTabProps): ReactNode {
  const [query, setQuery] = useState('')
  const [recordStatus, setRecordStatus] = useState<MemorySearchFilters['recordStatus']>('all')
  const [candidateStatus, setCandidateStatus] = useState<MemorySearchFilters['candidateStatus']>('pending')
  const [memoryKind, setMemoryKind] = useState<MemorySearchFilters['memoryKind']>()
  const [visibility, setVisibility] = useState<MemorySearchFilters['visibility']>()
  const [snapshot, setSnapshot] = useState<MemoryManagementSnapshotV1>()
  const [selected, setSelected] = useState<string[]>([])
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [sourceView, setSourceView] = useState<MemorySourceViewV1>()
  const [conflict, setConflict] = useState<MemoryConflictAssessmentV1>()
  const [editing, setEditing] = useState<{ candidate: MemoryCandidate; content: string }>()
  const [mergeContent, setMergeContent] = useState('')
  const [mergeKind, setMergeKind] = useState<MemoryCandidate['memoryKind']>('summary')
  const [mergeVisibility, setMergeVisibility] = useState<MemoryCandidate['visibility']>('personal')

  const filters = useMemo<MemorySearchFilters>(() => ({
    ...(query.trim() === '' ? {} : { query: query.trim() }),
    ...(memoryKind === undefined ? {} : { memoryKind }),
    ...(visibility === undefined ? {} : { visibility }),
    recordStatus,
    candidateStatus,
    limit: 200,
  }), [candidateStatus, memoryKind, query, recordStatus, visibility])

  useEffect(() => {
    let current = true
    setError(false)
    void search(filters).then(
      value => {
        if (!current) return
        setSnapshot(value)
        setSelected(ids => ids.filter(id => value.candidates.some(candidate => candidate.id === id && candidate.status === 'pending')))
      },
      () => { if (current) setError(true) },
    )
    return () => { current = false }
  }, [filters, refresh, search])

  const run = (operation: () => Promise<unknown>): void => {
    if (busy) return
    setBusy(true)
    setError(false)
    void operation().then(
      () => {
        setBusy(false)
        setConflict(undefined)
        setEditing(undefined)
        setRefresh(value => value + 1)
      },
      () => {
        setBusy(false)
        setError(true)
        setRefresh(value => value + 1)
      },
    )
  }

  const decide = (decisions: MemoryBatchDecisionV1[]): void => {
    run(async () => {
      const result = await batch(decisions)
      if (result.results.some(item => item.status === 'failed')) throw new Error('one or more memory decisions failed')
    })
  }

  const approve = (candidateId: string): void => {
    if (busy) return
    setBusy(true)
    setError(false)
    void assess(candidateId).then(async (assessment) => {
      const blocking = assessment.relationships.filter(item => item.relation === 'duplicate' || item.relation === 'conflict')
      if (blocking.length > 0) {
        setConflict({ ...assessment, relationships: blocking })
        setBusy(false)
        return
      }
      const result = await batch([{ candidateId, action: 'approve' }])
      if (result.results[0]?.status !== 'succeeded') throw new Error('memory approval failed')
      setBusy(false)
      setRefresh(value => value + 1)
    }).catch(() => {
      setBusy(false)
      setError(true)
    })
  }

  const toggle = (id: string): void => {
    setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  }

  if (snapshot === undefined) return <p className="mistymoon-status">{t('loading')}</p>
  const conflictCandidate = conflict === undefined
    ? undefined
    : snapshot.candidates.find(candidate => candidate.id === conflict.candidateId)

  return (
    <section className="mistymoon-settings mistymoon-memory-manager">
      <header>
        <h3>{t('memoryTitle')}</h3>
        <p>{t('memoryIntro')}</p>
      </header>
      <fieldset className="mistymoon-memory-filters">
        <legend>{t('memorySearch')}</legend>
        <input value={query} onChange={event => { setQuery(event.target.value) }} placeholder={t('memorySearchHint')} />
        <div className="mistymoon-grid">
          <label>{t('memoryRecordStatus')}
            <select value={recordStatus} onChange={event => { setRecordStatus(event.target.value as MemorySearchFilters['recordStatus']) }}>
              <option value="all">{t('all')}</option><option value="active">{t('active')}</option><option value="inactive">{t('inactive')}</option>
            </select>
          </label>
          <label>{t('memoryCandidateStatus')}
            <select value={candidateStatus} onChange={event => { setCandidateStatus(event.target.value as MemorySearchFilters['candidateStatus']) }}>
              <option value="all">{t('all')}</option><option value="pending">{t('pending')}</option><option value="approved">{t('approved')}</option><option value="rejected">{t('rejected')}</option><option value="superseded">{t('superseded')}</option>
            </select>
          </label>
          <label>{t('memoryKindFilter')}
            <select value={memoryKind ?? ''} onChange={event => { setMemoryKind((event.target.value || undefined) as MemorySearchFilters['memoryKind']) }}>
              <option value="">{t('all')}</option>{MEMORY_KINDS.map(kind => <option value={kind} key={kind}>{kind}</option>)}
            </select>
          </label>
          <label>{t('visibilityFilter')}
            <select value={visibility ?? ''} onChange={event => { setVisibility((event.target.value || undefined) as MemorySearchFilters['visibility']) }}>
              <option value="">{t('all')}</option><option value="personal">{t('personal')}</option><option value="confidential">{t('confidential')}</option>
            </select>
          </label>
        </div>
      </fieldset>

      {error ? <p className="mistymoon-validation" role="alert">{t('memoryActionError')}</p> : null}

      <fieldset>
        <legend>{t('memoryRecords')}</legend>
        {snapshot.records.length === 0 ? <p className="mistymoon-empty">{t('memoryNoRecords')}</p> : snapshot.records.map(record => (
          <article className="mistymoon-candidate" key={record.id}>
            <p>{record.content}</p><small>{record.memoryKind} · {record.status} · {record.createdAt}</small>
            <div className="mistymoon-candidate-actions"><button type="button" onClick={() => { run(async () => { setSourceView(await source('record', record.id)) }) }}>{t('memorySource')}</button></div>
          </article>
        ))}
      </fieldset>

      <fieldset>
        <legend>{t('memoryCandidates')}</legend>
        <div className="mistymoon-actions">
          <button type="button" disabled={busy || selected.length === 0} onClick={() => { decide(selected.map(candidateId => ({ candidateId, action: 'approve' }))) }}>{t('batchApprove')}</button>
          <button type="button" disabled={busy || selected.length === 0} onClick={() => { decide(selected.map(candidateId => ({ candidateId, action: 'reject' }))) }}>{t('batchReject')}</button>
        </div>
        {snapshot.candidates.length === 0 ? <p className="mistymoon-empty">{t('memoryNoCandidates')}</p> : snapshot.candidates.map(candidate => (
          <article className="mistymoon-candidate" key={candidate.id}>
            <label className="mistymoon-check"><input type="checkbox" disabled={candidate.status !== 'pending'} checked={selected.includes(candidate.id)} onChange={() => { toggle(candidate.id) }} />{t('memorySelect')}</label>
            <p>{candidate.content}</p><small>{candidate.memoryKind} · {candidate.visibility} · {candidate.status}</small>
            <div className="mistymoon-candidate-actions">
              <button type="button" onClick={() => { run(async () => { setSourceView(await source('candidate', candidate.id)) }) }}>{t('memorySource')}</button>
              {candidate.status === 'pending' ? <>
                <button type="button" onClick={() => { setEditing({ candidate, content: candidate.content }) }}>{t('memoryEdit')}</button>
                <button type="button" disabled={busy} onClick={() => { approve(candidate.id) }}>{t('candidateApprove')}</button>
                <button type="button" disabled={busy} onClick={() => { decide([{ candidateId: candidate.id, action: 'reject' }]) }}>{t('candidateReject')}</button>
              </> : null}
            </div>
          </article>
        ))}
        <div className="mistymoon-review">
          <h4>{t('mergeSelected')}</h4>
          <textarea value={mergeContent} onChange={event => { setMergeContent(event.target.value) }} placeholder={t('mergeContent')} />
          <div className="mistymoon-grid">
            <select value={mergeKind} onChange={event => { setMergeKind(event.target.value as MemoryCandidate['memoryKind']) }}>{MEMORY_KINDS.map(kind => <option value={kind} key={kind}>{kind}</option>)}</select>
            <select value={mergeVisibility} onChange={event => { setMergeVisibility(event.target.value as MemoryCandidate['visibility']) }}><option value="personal">{t('personal')}</option><option value="confidential">{t('confidential')}</option></select>
          </div>
          <button type="button" disabled={busy || selected.length < 2 || mergeContent.trim() === ''} onClick={() => { run(() => merge(selected, mergeContent, mergeKind, mergeVisibility)) }}>{t('mergeSelected')}</button>
        </div>
      </fieldset>

      {editing === undefined ? null : <fieldset>
        <legend>{t('memoryEdit')}</legend>
        <textarea value={editing.content} onChange={event => { setEditing({ ...editing, content: event.target.value }) }} />
        <div className="mistymoon-actions"><button type="button" className="mistymoon-secondary" onClick={() => { setEditing(undefined) }}>{t('cancel')}</button><button type="button" disabled={busy || editing.content.trim() === ''} onClick={() => { run(() => edit(editing.candidate, editing.content)) }}>{t('apply')}</button></div>
      </fieldset>}

      {conflict === undefined || conflictCandidate === undefined ? null : <fieldset>
        <legend>{t('conflictTitle')}</legend>
        {conflict.relationships.map(item => <div className="mistymoon-version" key={item.memoryId}><small>{item.relation} · {item.memoryId} · {item.reason}</small><button type="button" onClick={() => { decide([{ candidateId: conflictCandidate.id, action: 'approve', resolution: { kind: 'supersede', memoryId: item.memoryId } }]) }}>{t('supersedeThis')}</button></div>)}
        <button type="button" onClick={() => { decide([{ candidateId: conflictCandidate.id, action: 'approve', resolution: { kind: 'keep-both' } }]) }}>{t('keepBoth')}</button>
      </fieldset>}

      {sourceView === undefined ? null : <fieldset><legend>{t('memorySource')}</legend><pre className="mistymoon-preview">{JSON.stringify(sourceView, null, 2)}</pre></fieldset>}

      <fieldset><legend>{t('memoryAudit')}</legend>{snapshot.audit.length === 0 ? <p className="mistymoon-empty">{t('memoryNoAudit')}</p> : snapshot.audit.map(item => <div className="mistymoon-version" key={item.resultCandidateId}><small>{item.action} · {item.sourceCandidateIds.join(', ')} → {item.resultCandidateId} · {item.createdAt}</small></div>)}</fieldset>
    </section>
  )
}
