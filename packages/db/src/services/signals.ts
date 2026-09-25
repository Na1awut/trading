import type { Prisma } from '@prisma/client';
import {
  InvalidSignalParametersError,
  getRule,
  parseSignalParameters,
  signalName,
} from '@signals/signal-engine';
import type { SignalDTO, SignalParameters, SignalType, Timeframe } from '@signals/types';
import type { Db } from '../client';
import { ConflictError, DomainValidationError, NotFoundError } from '../errors';
import { toSignalDTO } from './mappers';

export async function listUserSignals(
  db: Db,
  userId: string,
  ticker?: string,
): Promise<SignalDTO[]> {
  const subs = await db.signalSubscription.findMany({
    where: { userId, ...(ticker ? { signalDefinition: { ticker } } : {}) },
    include: { signalDefinition: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return subs.map(toSignalDTO);
}

function validateParams(type: SignalType, raw: unknown): SignalParameters {
  try {
    return parseSignalParameters(type, raw);
  } catch (e) {
    if (e instanceof InvalidSignalParametersError) throw new DomainValidationError(e.message);
    throw e;
  }
}

/** Create a user-owned (custom) signal definition + subscription. Asset must already exist. */
export async function createCustomSignal(
  db: Db,
  params: {
    userId: string;
    ticker: string;
    signalType: SignalType;
    timeframe: Timeframe;
    parameters?: SignalParameters;
    name?: string;
  },
): Promise<SignalDTO> {
  const parameters = validateParams(params.signalType, params.parameters ?? {});
  const rule = getRule(params.signalType);
  const def = await db.signalDefinition.create({
    data: {
      ownerId: params.userId,
      name: params.name ?? signalName(params.signalType, parameters),
      description: rule.description,
      category: rule.category,
      signalType: params.signalType,
      ticker: params.ticker,
      timeframe: params.timeframe,
      parameters: parameters as Prisma.InputJsonObject,
      subscriptions: { create: { userId: params.userId } },
    },
    include: { subscriptions: true },
  });
  const sub = def.subscriptions[0]!;
  return toSignalDTO({ ...sub, signalDefinition: def });
}

async function findOwnSubscription(db: Db, userId: string, id: string) {
  const sub = await db.signalSubscription.findFirst({
    where: { id, userId },
    include: { signalDefinition: true },
  });
  if (!sub) throw new NotFoundError('Signal not found');
  return sub;
}

export async function updateSignal(
  db: Db,
  userId: string,
  id: string,
  patch: { enabled?: boolean; parameters?: SignalParameters; name?: string },
): Promise<SignalDTO> {
  const sub = await findOwnSubscription(db, userId, id);
  const def = sub.signalDefinition;
  const isPreset = def.ownerId === null;

  if ((patch.parameters || patch.name) && isPreset) {
    throw new ConflictError(
      'Preset signals are shared and cannot be edited - create a custom signal instead',
    );
  }
  if (patch.parameters || patch.name) {
    const parameters = patch.parameters
      ? validateParams(def.signalType, patch.parameters)
      : undefined;
    await db.signalDefinition.update({
      where: { id: def.id },
      data: {
        ...(parameters
          ? {
              parameters: parameters as Prisma.InputJsonObject,
              name: patch.name ?? signalName(def.signalType, parameters),
            }
          : { name: patch.name }),
      },
    });
    // New parameters -> old transition state is meaningless.
    if (parameters) await db.signalState.deleteMany({ where: { signalDefinitionId: def.id } });
  }
  if (patch.enabled !== undefined) {
    await db.signalSubscription.update({ where: { id }, data: { enabled: patch.enabled } });
  }
  return toSignalDTO(await findOwnSubscription(db, userId, id));
}

export async function deleteSignal(db: Db, userId: string, id: string): Promise<void> {
  const sub = await findOwnSubscription(db, userId, id);
  if (sub.signalDefinition.ownerId === null) {
    throw new ConflictError('Preset signals cannot be deleted - disable them instead');
  }
  // Cascades to the subscription and state; events keep their history (SetNull).
  await db.signalDefinition.delete({ where: { id: sub.signalDefinitionId } });
}
