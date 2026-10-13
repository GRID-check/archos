/**
 * Every live channel kind there is (ADR-0104). Explicit on purpose: a channel
 * is an authorization decision, and a list in one file is where review sees a
 * new one arrive. Add a kind with `defineChannel` and list it here.
 */

import 'server-only'
import type { AnyChannel } from './channel'
import { documentChannel } from './document-channel'
import { proposalChannel } from './proposal-channel'
import { channelKind } from './types'

export const CHANNELS: Readonly<Record<string, AnyChannel>> = {
  [documentChannel.kind]: documentChannel as AnyChannel,
  [proposalChannel.kind]: proposalChannel as AnyChannel,
}

export interface ResolvedChannel {
  key: string
  channel: AnyChannel
  params: unknown
}

/** The channel a key names, with its params; null for an unknown kind or a key its kind does not parse. */
export function resolveChannel(key: string, channels: Readonly<Record<string, AnyChannel>> = CHANNELS): ResolvedChannel | null {
  const kind = channelKind(key)
  if (!kind) return null
  const channel = Object.hasOwn(channels, kind) ? channels[kind] : undefined
  if (!channel) return null
  const params = channel.parse(key.slice(kind.length + 1))
  return params === null ? null : { key, channel, params }
}
