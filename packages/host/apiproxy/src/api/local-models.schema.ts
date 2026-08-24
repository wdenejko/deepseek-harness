/**
 * localModels domain zod schemas. `list` carries a nullable catalog (null when
 * the seam is absent); `start`/`stop` acknowledge with `{ ok: true }`.
 */

import { z } from 'zod'
import type { Wire } from './rpc.schema.ts'
import type { RequestPayload, ResponseValue } from './index.ts'

/** One catalog entry: a discovered run script with its resolved run-state. */
const localModelEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  alias: z.string().optional(),
  runState: z.enum(['running', 'starting', 'stopped']),
  scriptPath: z.string(),
})

/** The discovered catalog plus which entry serves the endpoint. */
const localModelCatalogSchema = z.object({
  providerId: z.string(),
  route: z.object({ provider: z.string(), model: z.string() }),
  running: z.string().nullable(),
  models: z.array(localModelEntrySchema),
})

/** Shared `{ ok: true }` acknowledgement of start/stop. */
const localModelsAckSchema = z.object({ ok: z.literal(true) })

/** localModels.list request payload (empty). */
export const localModelsListRequestSchema = z.object({}) as unknown as z.ZodType<Wire<RequestPayload<'localModels.list'>>>

/** localModels.list response value. */
export const localModelsListValueSchema = z.object({
  catalog: localModelCatalogSchema.nullable(),
}) as unknown as z.ZodType<Wire<ResponseValue<'localModels.list'>>>

/** localModels.start request payload. */
export const localModelsStartRequestSchema = z.object({
  id: z.string().min(1),
}) as unknown as z.ZodType<Wire<RequestPayload<'localModels.start'>>>

/** localModels.start response value. */
export const localModelsStartValueSchema = localModelsAckSchema as unknown as z.ZodType<Wire<ResponseValue<'localModels.start'>>>

/** localModels.stop request payload (empty). */
export const localModelsStopRequestSchema = z.object({}) as unknown as z.ZodType<Wire<RequestPayload<'localModels.stop'>>>

/** localModels.stop response value. */
export const localModelsStopValueSchema = localModelsAckSchema as unknown as z.ZodType<Wire<ResponseValue<'localModels.stop'>>>
