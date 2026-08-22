/** The SearXNG search provider's card: the metasearch endpoint the agent queries. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { SearxngCardFace } from './searxng-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the SearXNG card. */
export type SearxngCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<SearxngCardFace>

/**
 * Render the SearXNG search card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function SearxngCard(props: SearxngCardProps) {
  const { t } = props
  const state = props.useSearxngCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="searxngTitle"
      descriptionKey="searxngDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="plugin-config-searxng-endpoint"
        label={t('searxngBaseUrl')}
        hint={t('searxngBaseUrlHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        placeholder="http://localhost:8080"
        disabled={disabled}
        {...state.baseURL}
        onEdit={(text) => { props.edit('baseURL', text) }}
        onReset={() => { props.resetField('baseURL') }}
      />
      <ValueField
        id="plugin-config-searxng-language"
        label={t('searxngLanguage')}
        hint={t('searxngLanguageHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.language}
        onEdit={(text) => { props.edit('language', text) }}
        onReset={() => { props.resetField('language') }}
      />
      <ValueField
        id="plugin-config-searxng-safesearch"
        label={t('searxngSafeSearch')}
        hint={t('searxngSafeSearchHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.safeSearch}
        onEdit={(text) => { props.edit('safeSearch', text) }}
        onReset={() => { props.resetField('safeSearch') }}
      />
      <ValueField
        id="plugin-config-searxng-engines"
        label={t('searxngEngines')}
        hint={t('searxngEnginesHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        placeholder="google,bing"
        disabled={disabled}
        {...state.engines}
        onEdit={(text) => { props.edit('engines', text) }}
        onReset={() => { props.resetField('engines') }}
      />
    </PluginCard>
  )
}
