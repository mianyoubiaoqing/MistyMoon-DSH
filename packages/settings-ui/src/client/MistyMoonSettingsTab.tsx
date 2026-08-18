/** Private persona and memory settings editor. */

import { useEffect, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DEFAULT_CHARACTER_CARD_MAPPING,
} from '@mistymoon/dsh-foundation/character-card'
import type {
  CharacterCardPersonaMapping,
  MemoryCandidate,
  MistyMoonCharacterCardPreview,
  MistyMoonSettingsSnapshot,
  MistyMoonWorkModelSnapshot,
} from '../contracts.js'

/** Registration-side operations used by the settings page. */
export interface MistyMoonSettingsTabInjected {
  read: () => Promise<MistyMoonSettingsSnapshot>
  save: (settings: MistyMoonSettingsSnapshot) => Promise<MistyMoonSettingsSnapshot>
  publishPersona: () => Promise<MistyMoonSettingsSnapshot>
  discardPersona: () => Promise<MistyMoonSettingsSnapshot>
  rollbackPersona: (versionId: string) => Promise<MistyMoonSettingsSnapshot>
  previewCharacterCard: (
    fileName: string,
    contentBase64: string,
    mapping: CharacterCardPersonaMapping,
  ) => Promise<MistyMoonCharacterCardPreview>
  applyCharacterCard: (
    fileName: string,
    contentBase64: string,
    mapping: CharacterCardPersonaMapping,
  ) => Promise<MistyMoonSettingsSnapshot>
  listCandidates: () => Promise<MemoryCandidate[]>
  readWorkModel: () => Promise<MistyMoonWorkModelSnapshot>
  saveWorkModel: (input: {
    expectedRevision: number
    provider: string
    model: string
    ownerConfirmed: boolean
  }) => Promise<MistyMoonWorkModelSnapshot>
  approveCandidate: (candidateId: string) => Promise<void>
  rejectCandidate: (candidateId: string) => Promise<void>
}

/** Props assembled by the Settings slot renderer. */
export type MistyMoonSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.mistymoon'>
  & InjectFace<MistyMoonSettingsTabInjected>

type LoadState = 'loading' | 'error' | 'ready'
type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type CardState = 'idle' | 'reading' | 'previewed' | 'applying' | 'applied' | 'error'
interface CandidateDecisionState {
  id: string
  action: 'approve' | 'reject'
}

function lines(value: string): string[] {
  return value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean)
}

function renderDialogs(dialogs: MistyMoonSettingsSnapshot['persona']['referenceDialogs']): string {
  return dialogs.map(dialog => `${dialog.user} => ${dialog.assistant}`).join('\n')
}

function parseDialogs(value: string): MistyMoonSettingsSnapshot['persona']['referenceDialogs'] {
  return value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean).map((item) => {
    const separator = item.indexOf(' => ')
    return separator < 0
      ? { user: item, assistant: '' }
      : { user: item.slice(0, separator).trim(), assistant: item.slice(separator + 4).trim() }
  })
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  }
  return btoa(binary)
}

/** Render the private MistyMoon settings editor. */
export function MistyMoonSettingsTab({
  read,
  save,
  publishPersona,
  discardPersona,
  rollbackPersona,
  previewCharacterCard,
  applyCharacterCard,
  listCandidates,
  readWorkModel,
  saveWorkModel,
  approveCandidate,
  rejectCandidate,
  t,
}: MistyMoonSettingsTabProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [draft, setDraft] = useState<MistyMoonSettingsSnapshot | undefined>()
  const [candidates, setCandidates] = useState<MemoryCandidate[]>([])
  const [workModel, setWorkModel] = useState<MistyMoonWorkModelSnapshot>()
  const [workModelChoice, setWorkModelChoice] = useState('')
  const [workModelState, setWorkModelState] = useState<SaveState>('idle')
  const [candidateDecision, setCandidateDecision] = useState<CandidateDecisionState | undefined>()
  const [candidateError, setCandidateError] = useState(false)
  const [cardState, setCardState] = useState<CardState>('idle')
  const [cardFile, setCardFile] = useState<{ name: string; contentBase64: string }>()
  const [cardMapping, setCardMapping] = useState<CharacterCardPersonaMapping>({ ...DEFAULT_CHARACTER_CARD_MAPPING })
  const [cardPreview, setCardPreview] = useState<MistyMoonCharacterCardPreview>()

  useEffect(() => {
    let current = true
    setLoadState('loading')
    void Promise.all([read(), listCandidates(), readWorkModel()]).then(
      ([settings, nextCandidates, nextWorkModel]) => {
        if (!current) return
        setDraft(settings)
        setCandidates(nextCandidates)
        setWorkModel(nextWorkModel)
        setWorkModelChoice(`${nextWorkModel.selection.provider}\u0000${nextWorkModel.selection.model}`)
        setWorkModelState('idle')
        setLoadState('ready')
        setSaveState('idle')
        setCandidateError(false)
      },
      () => { if (current) setLoadState('error') },
    )
    return () => { current = false }
  }, [listCandidates, read, readWorkModel, request])

  if (loadState === 'loading') return <p className="mistymoon-status">{t('loading')}</p>
  if (loadState === 'error' || draft === undefined) {
    return (
      <div className="mistymoon-error" role="alert">
        <p>{t('loadError')}</p>
        <button type="button" onClick={() => { setRequest(value => value + 1) }}>{t('retry')}</button>
      </div>
    )
  }

  const valid = draft.persona.displayName.trim() !== ''
    && draft.persona.identity.summary.trim() !== ''
    && draft.persona.identity.relationship.trim() !== ''
    && draft.persona.identity.familiarRelationship.trim() !== ''
    && draft.persona.identity.strangerRelationship.trim() !== ''
    && draft.persona.style.instructions.trim() !== ''
    && draft.persona.referenceDialogs.every(dialog => dialog.user.trim() !== '' && dialog.assistant.trim() !== '')
    && Object.values(draft.persona.responseBudgets).every(budget =>
      Number.isSafeInteger(budget.targetCharacters)
      && budget.targetCharacters >= 1
      && Number.isSafeInteger(budget.maxOutputTokens)
      && budget.maxOutputTokens >= 1)
    && Number.isSafeInteger(draft.recallLimit)
    && draft.recallLimit >= 1
    && draft.recallLimit <= 20

  const updatePersona = (persona: MistyMoonSettingsSnapshot['persona']): void => {
    setDraft(current => current === undefined ? current : { ...current, persona })
    setSaveState('idle')
  }

  const submit = (): void => {
    if (!valid || saveState === 'saving') return
    setSaveState('saving')
    void save(draft).then(
      (settings) => {
        setDraft(settings)
        setSaveState('saved')
      },
      () => { setSaveState('error') },
    )
  }

  const updateWorkspace = (operation: () => Promise<MistyMoonSettingsSnapshot>): void => {
    if (saveState === 'saving') return
    setSaveState('saving')
    void operation().then(
      (settings) => {
        setDraft(settings)
        setSaveState('saved')
      },
      () => { setSaveState('error') },
    )
  }

  const resolveCandidate = (candidateId: string, decision: 'approve' | 'reject'): void => {
    if (candidateDecision !== undefined) return
    setCandidateDecision({ id: candidateId, action: decision })
    setCandidateError(false)
    const operation = decision === 'approve' ? approveCandidate(candidateId) : rejectCandidate(candidateId)
    void operation.then(
      () => {
        setCandidates(current => current.filter(candidate => candidate.id !== candidateId))
        setCandidateDecision(undefined)
      },
      () => {
        setCandidateDecision(undefined)
        setCandidateError(true)
      },
    )
  }

  const refreshCardPreview = (file = cardFile, mapping = cardMapping): void => {
    if (file === undefined || cardState === 'reading' || cardState === 'applying') return
    setCardState('reading')
    void previewCharacterCard(file.name, file.contentBase64, mapping).then(
      (preview) => {
        setCardPreview(preview)
        setCardState('previewed')
      },
      () => {
        setCardPreview(undefined)
        setCardState('error')
      },
    )
  }

  const readCard = (file: File | undefined): void => {
    if (file === undefined) return
    setCardState('reading')
    setCardPreview(undefined)
    void file.arrayBuffer().then(
      (buffer) => {
        const next = { name: file.name, contentBase64: bytesToBase64(new Uint8Array(buffer)) }
        setCardFile(next)
        refreshCardPreview(next, cardMapping)
      },
      () => { setCardState('error') },
    )
  }

  const applyCard = (): void => {
    if (cardFile === undefined || cardPreview === undefined || cardState === 'applying') return
    setCardState('applying')
    void applyCharacterCard(cardFile.name, cardFile.contentBase64, cardMapping).then(
      (settings) => {
        setDraft(settings)
        setCardState('applied')
      },
      () => { setCardState('error') },
    )
  }

  const selectedWorkModel = workModel?.options.find(option =>
    `${option.provider}\u0000${option.model}` === workModelChoice)
  const applyWorkModel = (): void => {
    if (workModel === undefined || selectedWorkModel === undefined || workModelState === 'saving') return
    setWorkModelState('saving')
    void saveWorkModel({
      expectedRevision: workModel.selection.revision,
      provider: selectedWorkModel.provider,
      model: selectedWorkModel.model,
      ownerConfirmed: selectedWorkModel.qualification !== 'qualified-direct',
    }).then(
      (next) => {
        setWorkModel(next)
        setWorkModelChoice(`${next.selection.provider}\u0000${next.selection.model}`)
        setWorkModelState('saved')
      },
      () => { setWorkModelState('error') },
    )
  }

  return (
    <section className="mistymoon-settings" aria-labelledby="mistymoon-settings-title">
      <header>
        <h3 id="mistymoon-settings-title">{t('title')}</h3>
        <p>{t('intro')}</p>
      </header>

      <fieldset>
        <legend>{t('workModel')}</legend>
        <p className="mistymoon-status">{t('workModelHint')}</p>
        {workModel === undefined || workModel.options.length === 0 ? (
          <p className="mistymoon-validation">{t('workModelEmpty')}</p>
        ) : (
          <label>
            <span>{t('workModelSelect')}</span>
            <select
              value={workModelChoice}
              onChange={(event) => {
                setWorkModelChoice(event.currentTarget.value)
                setWorkModelState('idle')
              }}
            >
              {workModel.options.map(option => (
                <option key={`${option.provider}\u0000${option.model}`} value={`${option.provider}\u0000${option.model}`}>
                  {option.providerName} — {option.modelName}
                </option>
              ))}
            </select>
          </label>
        )}
        {selectedWorkModel?.qualification === 'experimental-owner-configured'
          ? <p className="mistymoon-validation">{t('workModelExperimental')}</p>
          : <p className="mistymoon-status">{t('workModelQualified')}</p>}
        <div className="mistymoon-actions">
          <button
            type="button"
            disabled={selectedWorkModel === undefined || workModelState === 'saving'}
            onClick={applyWorkModel}
          >
            {workModelState === 'saving' ? t('saving') : t('workModelApply')}
          </button>
        </div>
        {workModelState === 'saved' ? <p className="mistymoon-success">{t('workModelSaved')}</p> : null}
        {workModelState === 'error' ? <p className="mistymoon-validation">{t('workModelError')}</p> : null}
      </fieldset>

      <fieldset className="mistymoon-import">
        <legend>{t('cardImport')}</legend>
        <p className="mistymoon-status">{t('cardImportHint')}</p>
        <input
          type="file"
          accept=".json,.png,.apng,.charx,application/json,image/png,application/zip"
          onChange={(event) => { readCard(event.currentTarget.files?.[0]) }}
        />
        {cardPreview === undefined ? null : (
          <>
            <div className="mistymoon-import-meta">
              <span>{cardPreview.source.container.toUpperCase()}</span>
              <span>{cardPreview.draft.source.generation.toUpperCase()}</span>
              <span>{cardPreview.source.byteLength} bytes</span>
              <span>{cardPreview.draft.character.name}</span>
            </div>
            <div className="mistymoon-grid">
              <label>
                <span>{t('cardDisplayName')}</span>
                <select
                  value={cardMapping.displayName}
                  onChange={(event) => {
                    setCardMapping({ ...cardMapping, displayName: event.currentTarget.value as 'name' | 'nickname' })
                    setCardState('idle')
                  }}
                >
                  <option value="name">{t('cardName')}</option>
                  <option value="nickname">{t('cardNickname')}</option>
                </select>
              </label>
              {([
                ['includeDescription', 'cardDescription'],
                ['includePersonality', 'cardPersonality'],
                ['includeScenarioAsRelationship', 'cardScenario'],
                ['includeSystemPrompt', 'cardSystemPrompt'],
                ['includePostHistoryInstructions', 'cardPostHistory'],
                ['includeExampleDialog', 'cardExamples'],
              ] as const).map(([key, label]) => (
                <label className="mistymoon-check" key={key}>
                  <input
                    type="checkbox"
                    checked={cardMapping[key]}
                    onChange={(event) => {
                      setCardMapping({ ...cardMapping, [key]: event.currentTarget.checked })
                      setCardState('idle')
                    }}
                  />
                  <span>{t(label)}</span>
                </label>
              ))}
            </div>
            {cardPreview.warnings.length === 0 ? null : (
              <ul className="mistymoon-import-warnings">
                {cardPreview.warnings.map(warning => <li key={warning}>{warning}</li>)}
              </ul>
            )}
            <label>
              <span>{t('cardMappedPreview')}</span>
              <pre className="mistymoon-preview">{JSON.stringify(cardPreview.persona, null, 2)}</pre>
            </label>
            <small>{t('cardMetadataWarning')}</small>
            <div className="mistymoon-actions">
              <button
                className="mistymoon-secondary"
                type="button"
                disabled={cardState === 'reading' || cardState === 'applying'}
                onClick={() => { refreshCardPreview() }}
              >
                {t('cardRefreshPreview')}
              </button>
              <button type="button" disabled={cardState !== 'previewed'} onClick={applyCard}>
                {t('cardApplyDraft')}
              </button>
            </div>
          </>
        )}
        {cardState === 'reading' ? <p className="mistymoon-status">{t('cardReading')}</p> : null}
        {cardState === 'applying' ? <p className="mistymoon-status">{t('cardApplying')}</p> : null}
        {cardState === 'applied' ? <p className="mistymoon-success">{t('cardApplied')}</p> : null}
        {cardState === 'error' ? <p className="mistymoon-validation" role="alert">{t('cardError')}</p> : null}
      </fieldset>

      <fieldset>
        <legend>{t('persona')}</legend>
        <label>
          <span>{t('displayName')}</span>
          <input
            value={draft.persona.displayName}
            onChange={(event) => { updatePersona({ ...draft.persona, displayName: event.currentTarget.value }) }}
          />
        </label>
        <label>
          <span>{t('summary')}</span>
          <textarea
            rows={3}
            value={draft.persona.identity.summary}
            onChange={(event) => {
              updatePersona({
                ...draft.persona,
                identity: { ...draft.persona.identity, summary: event.currentTarget.value },
              })
            }}
          />
        </label>
        <label>
          <span>{t('relationship')}</span>
          <textarea
            rows={3}
            value={draft.persona.identity.relationship}
            onChange={(event) => {
              updatePersona({
                ...draft.persona,
                identity: { ...draft.persona.identity, relationship: event.currentTarget.value },
              })
            }}
          />
        </label>
        <div className="mistymoon-grid">
          <label>
            <span>{t('familiarRelationship')}</span>
            <textarea
              rows={3}
              value={draft.persona.identity.familiarRelationship}
              onChange={(event) => {
                updatePersona({
                  ...draft.persona,
                  identity: { ...draft.persona.identity, familiarRelationship: event.currentTarget.value },
                })
              }}
            />
          </label>
          <label>
            <span>{t('strangerRelationship')}</span>
            <textarea
              rows={3}
              value={draft.persona.identity.strangerRelationship}
              onChange={(event) => {
                updatePersona({
                  ...draft.persona,
                  identity: { ...draft.persona.identity, strangerRelationship: event.currentTarget.value },
                })
              }}
            />
          </label>
        </div>
        <div className="mistymoon-grid">
          <label>
            <span>{t('tone')}</span>
            <textarea
              rows={5}
              value={draft.persona.style.tone.join('\n')}
              onChange={(event) => {
                updatePersona({
                  ...draft.persona,
                  style: { ...draft.persona.style, tone: lines(event.currentTarget.value) },
                })
              }}
            />
            <small>{t('toneHint')}</small>
          </label>
          <label>
            <span>{t('avoid')}</span>
            <textarea
              rows={5}
              value={draft.persona.style.avoid.join('\n')}
              onChange={(event) => {
                updatePersona({
                  ...draft.persona,
                  style: { ...draft.persona.style, avoid: lines(event.currentTarget.value) },
                })
              }}
            />
            <small>{t('avoidHint')}</small>
          </label>
        </div>
        <label>
          <span>{t('styleInstructions')}</span>
          <textarea
            rows={7}
            value={draft.persona.style.instructions}
            onChange={(event) => {
              updatePersona({
                ...draft.persona,
                style: { ...draft.persona.style, instructions: event.currentTarget.value },
              })
            }}
          />
        </label>
        <label>
          <span>{t('advancedInstructions')}</span>
          <textarea
            rows={5}
            value={draft.persona.advancedInstructions}
            onChange={(event) => { updatePersona({ ...draft.persona, advancedInstructions: event.currentTarget.value }) }}
          />
        </label>
        <label>
          <span>{t('referenceDialogs')}</span>
          <textarea
            rows={7}
            value={renderDialogs(draft.persona.referenceDialogs)}
            onChange={(event) => {
              updatePersona({ ...draft.persona, referenceDialogs: parseDialogs(event.currentTarget.value) })
            }}
          />
          <small>{t('referenceDialogsHint')}</small>
        </label>
        <div className="mistymoon-grid">
          {(['brief', 'normal', 'deep'] as const).map((name) => (
            <fieldset key={name}>
              <legend>{t(name)}</legend>
              <label>
                <span>{t('targetCharacters')}</span>
                <input
                  type="number"
                  min={1}
                  value={draft.persona.responseBudgets[name].targetCharacters}
                  onChange={(event) => {
                    updatePersona({
                      ...draft.persona,
                      responseBudgets: {
                        ...draft.persona.responseBudgets,
                        [name]: {
                          ...draft.persona.responseBudgets[name],
                          targetCharacters: Number(event.currentTarget.value),
                        },
                      },
                    })
                  }}
                />
              </label>
              <label>
                <span>{t('maxOutputTokens')}</span>
                <input
                  type="number"
                  min={1}
                  value={draft.persona.responseBudgets[name].maxOutputTokens}
                  onChange={(event) => {
                    updatePersona({
                      ...draft.persona,
                      responseBudgets: {
                        ...draft.persona.responseBudgets,
                        [name]: {
                          ...draft.persona.responseBudgets[name],
                          maxOutputTokens: Number(event.currentTarget.value),
                        },
                      },
                    })
                  }}
                />
              </label>
            </fieldset>
          ))}
        </div>
        <label className="mistymoon-check">
          <input
            type="checkbox"
            checked={draft.persona.boundaries.privateByDefault}
            onChange={(event) => {
              updatePersona({
                ...draft.persona,
                boundaries: { ...draft.persona.boundaries, privateByDefault: event.currentTarget.checked },
              })
            }}
          />
          <span>{t('privacy')}</span>
        </label>
        <label className="mistymoon-check">
          <input
            type="checkbox"
            checked={draft.persona.boundaries.requireApprovalForExternalActions}
            onChange={(event) => {
              updatePersona({
                ...draft.persona,
                boundaries: {
                  ...draft.persona.boundaries,
                  requireApprovalForExternalActions: event.currentTarget.checked,
                },
              })
            }}
          />
          <span>{t('approval')}</span>
        </label>
      </fieldset>

      <fieldset>
        <legend>{t('memory')}</legend>
        <label>
          <span>{t('recallLimit')}</span>
          <input
            type="number"
            min={1}
            max={20}
            step={1}
            value={draft.recallLimit}
            onChange={(event) => {
              setDraft({ ...draft, recallLimit: Number(event.currentTarget.value) })
              setSaveState('idle')
            }}
          />
          <small>{t('recallLimitHint')}</small>
        </label>
        <div className="mistymoon-review" aria-labelledby="mistymoon-candidate-title">
          <div>
            <h4 id="mistymoon-candidate-title">{t('candidateTitle')}</h4>
            <p>{t('candidateHint')}</p>
          </div>
          {candidates.length === 0 ? <p className="mistymoon-empty">{t('candidateEmpty')}</p> : null}
          {candidates.map(candidate => (
            <article className="mistymoon-candidate" key={candidate.id}>
              <p>{candidate.content}</p>
              <small>{candidate.visibility === 'confidential' ? t('confidential') : t('personal')}</small>
              <div className="mistymoon-candidate-actions">
                <button
                  type="button"
                  disabled={candidateDecision !== undefined}
                  onClick={() => { resolveCandidate(candidate.id, 'approve') }}
                >
                  {candidateDecision?.id === candidate.id && candidateDecision.action === 'approve'
                    ? t('reviewing')
                    : t('candidateApprove')}
                </button>
                <button
                  type="button"
                  disabled={candidateDecision !== undefined}
                  onClick={() => { resolveCandidate(candidate.id, 'reject') }}
                >
                  {candidateDecision?.id === candidate.id && candidateDecision.action === 'reject'
                    ? t('reviewing')
                    : t('candidateReject')}
                </button>
              </div>
            </article>
          ))}
          {candidateError ? <p className="mistymoon-validation" role="alert">{t('candidateError')}</p> : null}
        </div>
      </fieldset>

      {!valid ? <p className="mistymoon-validation" role="alert">{t('invalid')}</p> : null}
      {draft.hasPersonaDraft ? (
        <fieldset>
          <legend>{t('draftPreview')}</legend>
          <p className="mistymoon-status">{t('draftHint')}</p>
          <pre className="mistymoon-preview">{draft.personaPreview}</pre>
        </fieldset>
      ) : null}
      {draft.personaVersions.length > 0 ? (
        <fieldset>
          <legend>{t('versionHistory')}</legend>
          {draft.personaVersions.map(version => (
            <div className="mistymoon-version" key={version.id}>
              <small>{version.displayName} · {new Date(version.createdAt).toLocaleString()}</small>
              <button
                type="button"
                disabled={draft.hasPersonaDraft || saveState === 'saving'}
                onClick={() => { updateWorkspace(() => rollbackPersona(version.id)) }}
              >
                {t('rollback')}
              </button>
            </div>
          ))}
          {draft.hasPersonaDraft ? <small>{t('rollbackDraftWarning')}</small> : null}
        </fieldset>
      ) : null}
      {saveState === 'saved' ? <p className="mistymoon-success" role="status">{t('saved')}</p> : null}
      {saveState === 'error' ? <p className="mistymoon-validation" role="alert">{t('saveError')}</p> : null}
      <div className="mistymoon-actions">
        <button
          className="mistymoon-secondary"
          type="button"
          disabled={!draft.hasPersonaDraft || saveState === 'saving'}
          onClick={() => { updateWorkspace(discardPersona) }}
        >
          {t('discardDraft')}
        </button>
        <button
          type="button"
          disabled={!draft.hasPersonaDraft || saveState === 'saving'}
          onClick={() => { updateWorkspace(publishPersona) }}
        >
          {t('publishPersona')}
        </button>
        <button type="button" disabled={!valid || saveState === 'saving'} onClick={submit}>
          {saveState === 'saving' ? t('saving') : t('saveDraft')}
        </button>
      </div>
    </section>
  )
}
